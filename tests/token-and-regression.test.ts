import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User, USER_ROLES, USER_STATUSES } from "../src/modules/users/user.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as authService from "../src/modules/auth/auth.service.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { AppError } from "../src/errors/app.error.js";

const runTests = async () => {
  console.log("=== Starting Token Engine & Regression Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `token_test_a_${testTimestamp}@example.com`;
  const userBEmail = `token_test_b_${testTimestamp}@example.com`;
  const adminEmail = `token_admin_${testTimestamp}@example.com`;
  const suspendedEmail = `token_suspended_${testTimestamp}@example.com`;
  const disabledEmail = `token_disabled_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  try {
    // -------------------------------------------------------------
    // Test 1: User Registration automatically initializes Token Balance
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing User Registration & Automatic Balance Initialization...");
    const regResultA = await authService.register({
      email: userAEmail,
      password: testPassword,
    });
    assert.ok(regResultA.user.id, "User A should have an ID");
    assert.ok(regResultA.accessToken, "User A should have an access token");

    const initialBalanceA = await tokenService.getBalance(regResultA.user.id);
    assert.equal(initialBalanceA.balance, 100, "Initial balance should be 100 credits");
    console.log("✓ Initial balance correctly set to 100 on registration");

    // -------------------------------------------------------------
    // Test 2: Duplicate Balance Initialization is Idempotent (Never Overwrites)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing Duplicate Balance Initialization...");
    const duplicateResult = await tokenService.initializeBalance(regResultA.user.id, 9999);
    assert.equal(duplicateResult.balance, 100, "Duplicate initialization must NOT overwrite existing balance");
    const checkBalance = await tokenService.getBalance(regResultA.user.id);
    assert.equal(checkBalance.balance, 100, "Current balance must remain 100");
    console.log("✓ Duplicate initialization safely returned existing balance without overwriting");

    // -------------------------------------------------------------
    // Test 3: Valid Deduction
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing Valid Deduction...");
    const deductedResult = await tokenService.deductCredits(regResultA.user.id, 30);
    assert.equal(deductedResult.balance, 70, "100 - 30 should equal 70");
    const currentBalanceA = await tokenService.getBalance(regResultA.user.id);
    assert.equal(currentBalanceA.balance, 70, "Stored balance should be 70");
    console.log("✓ Valid deduction correctly updated balance from 100 to 70");

    // -------------------------------------------------------------
    // Test 4: Invalid Deduction Amounts (Zero, Negative, Decimal, NaN, Infinity)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing Invalid Deduction Amounts...");
    const testInvalidAmount = async (amount: number, label: string) => {
      let threw = false;
      try {
        await tokenService.deductCredits(regResultA.user.id, amount);
      } catch (err) {
        threw = true;
        assert.ok(err instanceof AppError, `Expected AppError for ${label}`);
        assert.equal(err.code, "INVALID_CREDIT_AMOUNT", `Expected INVALID_CREDIT_AMOUNT for ${label}`);
        assert.equal(err.statusCode, 400, `Expected HTTP 400 for ${label}`);
      }
      assert.ok(threw, `Expected deduction with ${label} to throw`);
    };

    await testInvalidAmount(0, "zero");
    await testInvalidAmount(-10, "negative number");
    await testInvalidAmount(15.5, "decimal number");
    await testInvalidAmount(NaN, "NaN");
    await testInvalidAmount(Infinity, "Infinity");
    console.log("✓ Zero, negative, decimal, NaN, and Infinity deductions were all rejected with 400 INVALID_CREDIT_AMOUNT");

    // -------------------------------------------------------------
    // Test 5: Insufficient Balance Rejection & No Partial Deduction
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing Insufficient Balance...");
    let insufficientThrew = false;
    try {
      // Balance is 70; requesting 80
      await tokenService.deductCredits(regResultA.user.id, 80);
    } catch (err) {
      insufficientThrew = true;
      assert.ok(err instanceof AppError, "Expected AppError on insufficient balance");
      assert.equal(err.code, "INSUFFICIENT_CREDITS", "Expected INSUFFICIENT_CREDITS");
      assert.equal(err.statusCode, 402, "Expected HTTP 402 Payment Required");
    }
    assert.ok(insufficientThrew, "Expected insufficient balance to throw");

    // Verify balance is completely untouched
    const untouchedBalance = await tokenService.getBalance(regResultA.user.id);
    assert.equal(untouchedBalance.balance, 70, "Balance must still be exactly 70");
    console.log("✓ Insufficient balance rejected with 402 INSUFFICIENT_CREDITS and balance was not partially deducted");

    // -------------------------------------------------------------
    // Test 6: Exact-Balance Deduction (Balance reaches 0)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing Exact-Balance Deduction...");
    const exactDeductResult = await tokenService.deductCredits(regResultA.user.id, 70);
    assert.equal(exactDeductResult.balance, 0, "70 - 70 should equal 0");

    // Now balance is 0, attempting to deduct 1 should fail
    let zeroBalanceThrew = false;
    try {
      await tokenService.deductCredits(regResultA.user.id, 1);
    } catch (err) {
      zeroBalanceThrew = true;
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "INSUFFICIENT_CREDITS");
      assert.equal(err.statusCode, 402);
    }
    assert.ok(zeroBalanceThrew, "Deducting from 0 balance must fail");
    console.log("✓ Exact-balance deduction reached exactly 0, and further deductions were rejected");

    // -------------------------------------------------------------
    // Test 7: CONCURRENCY TEST (Mandatory)
    // Balance = 100, Two simultaneous requests of 80. Exactly one succeeds, one fails, final = 20.
    // -------------------------------------------------------------
    console.log("\n[Test 7] Running Concurrency Test (Two simultaneous deductions of 80 against 100)...");
    const regResultB = await authService.register({
      email: userBEmail,
      password: testPassword,
    });
    // User B has initial balance of 100
    const userBInitial = await tokenService.getBalance(regResultB.user.id);
    assert.equal(userBInitial.balance, 100, "User B should start with 100");

    // Fire two simultaneous deductions of 80
    const [res1, res2] = await Promise.allSettled([
      tokenService.deductCredits(regResultB.user.id, 80),
      tokenService.deductCredits(regResultB.user.id, 80),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<tokenService.TokenBalanceResult>[];
    const rejected = [res1, res2].filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    assert.equal(fulfilled.length, 1, "Exactly one deduction must succeed");
    assert.equal(rejected.length, 1, "Exactly one deduction must fail");

    assert.equal(fulfilled[0]!.value.balance, 20, "Successful deduction must return new balance of 20");
    const rejectedError = rejected[0]!.reason;
    assert.ok(rejectedError instanceof AppError, "Failed deduction must reject with AppError");
    assert.equal(rejectedError.code, "INSUFFICIENT_CREDITS", "Failed deduction must have INSUFFICIENT_CREDITS code");
    assert.equal(rejectedError.statusCode, 402, "Failed deduction must return HTTP 402");

    // Verify DB state
    const userBFinalBalance = await tokenService.getBalance(regResultB.user.id);
    assert.equal(userBFinalBalance.balance, 20, "Final balance in DB must be exactly 20");
    console.log("✓ Concurrency test passed: Exactly 1 succeeded, 1 rejected with INSUFFICIENT_CREDITS, final balance is 20!");

    // -------------------------------------------------------------
    // Test 8: Non-Existent User / Invalid User ID Handling
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing Non-Existent User & Invalid ID Handling...");
    let invalidIdThrew = false;
    try {
      await tokenService.getBalance("invalid-object-id");
    } catch (err) {
      invalidIdThrew = true;
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "INVALID_USER_ID");
      assert.equal(err.statusCode, 400);
    }
    assert.ok(invalidIdThrew, "Invalid user ID should be rejected");

    let nonExistentThrew = false;
    const fakeObjectId = "507f1f77bcf86cd799439011";
    try {
      await tokenService.deductCredits(fakeObjectId, 10);
    } catch (err) {
      nonExistentThrew = true;
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "TOKEN_BALANCE_NOT_FOUND");
      assert.equal(err.statusCode, 404);
    }
    assert.ok(nonExistentThrew, "Deducting from non-existent user should return TOKEN_BALANCE_NOT_FOUND");
    console.log("✓ Invalid user ID and non-existent balance handled cleanly");

    // -------------------------------------------------------------
    // Test 9: HTTP API Tests (GET /api/v1/tokens/balance)
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing HTTP API Endpoints...");

    // 9a. Authenticated request
    const authRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: {
        Authorization: `Bearer ${regResultB.accessToken}`,
      },
    });
    assert.equal(authRes.status, 200, "Authenticated balance should return 200");
    const authJson = await authRes.json();
    assert.equal(authJson.success, true);
    assert.equal(authJson.data.balance, 20, "API should return user B balance (20)");
    assert.ok(authJson.data.updatedAt, "API should return updatedAt timestamp");
    assert.equal(authJson.data._id, undefined, "API must NOT leak internal MongoDB _id");
    assert.equal(authJson.data.userId, undefined, "API must NOT leak internal MongoDB userId");
    console.log("✓ Authenticated balance request returned 200 with clean data shape");

    // 9b. Unauthenticated request
    const unauthRes = await fetch(`${baseUrl}/api/v1/tokens/balance`);
    assert.equal(unauthRes.status, 401, "Unauthenticated request should return 401");
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.success, false);
    assert.equal(unauthJson.error.code, "UNAUTHORIZED");
    console.log("✓ Unauthenticated request rejected with 401 UNAUTHORIZED");

    // 9c. Invalid / malformed token
    const malformedRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: {
        Authorization: "Bearer invalid.jwt.token",
      },
    });
    assert.equal(malformedRes.status, 401, "Malformed token should return 401");
    console.log("✓ Malformed token rejected with 401 UNAUTHORIZED");

    // 9d. Unexpected request fields (strict validation test)
    const unexpectedRes = await fetch(`${baseUrl}/api/v1/tokens/balance?unexpectedField=malicious`, {
      headers: {
        Authorization: `Bearer ${regResultB.accessToken}`,
      },
    });
    assert.equal(unexpectedRes.status, 400, "Unexpected query params must be rejected with 400");
    const unexpectedJson = await unexpectedRes.json();
    assert.equal(unexpectedJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Unexpected request parameters rejected with 400 VALIDATION_ERROR");

    // 9e. Cross-user isolation
    const authResA = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(authResA.status, 200);
    const authJsonA = await authResA.json();
    assert.equal(authJsonA.data.balance, 0, "User A balance should be 0");
    assert.notEqual(authJsonA.data.balance, authJson.data.balance, "User balances must remain isolated");
    console.log("✓ Cross-user isolation verified: Each user only accesses their own balance");

    // -------------------------------------------------------------
    // Test 10: Regression Tests (Auth, Users, Conversations, Messages)
    // -------------------------------------------------------------
    console.log("\n[Test 10] Running Regression Tests on Existing APIs...");

    // 10a. Login with existing credentials
    const loginRes = await authService.login({
      email: userAEmail,
      password: testPassword,
    });
    assert.ok(loginRes.accessToken, "Login must succeed and return access token");
    console.log("✓ Existing Auth login verified");

    // 10b. User Profile API Security Tests (IDOR/BOLA Protection)
    // 1. Authenticated USER requesting own profile -> 200 OK, no passwordHash
    const userProfileRes = await fetch(`${baseUrl}/api/v1/users/${regResultA.user.id}`, {
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(userProfileRes.status, 200, "User profile API should return 200 for own profile");
    const userProfileJson = await userProfileRes.json();
    assert.equal(userProfileJson.success, true);
    assert.equal(userProfileJson.data._id, regResultA.user.id);
    assert.equal(userProfileJson.data.email, userAEmail);
    assert.equal(userProfileJson.data.passwordHash, undefined, "Response must not contain passwordHash");

    // 2. Unauthenticated request -> 401 Unauthorized
    const unauthProfileRes = await fetch(`${baseUrl}/api/v1/users/${regResultA.user.id}`);
    assert.equal(unauthProfileRes.status, 401, "Unauthenticated request should return 401");
    const unauthProfileJson = await unauthProfileRes.json();
    assert.equal(unauthProfileJson.error.code, "UNAUTHORIZED");

    // 3. Authenticated USER requesting another user's profile -> 403 Forbidden
    const crossProfileRes = await fetch(`${baseUrl}/api/v1/users/${regResultB.user.id}`, {
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(crossProfileRes.status, 403, "User requesting another profile should return 403");
    const crossProfileJson = await crossProfileRes.json();
    assert.equal(crossProfileJson.error.code, "FORBIDDEN");

    // 4. Authenticated ADMIN requesting another user's profile -> 200 OK, no passwordHash
    const adminUser = await User.create({
      email: adminEmail,
      passwordHash: "dummyhash",
      status: USER_STATUSES.ACTIVE,
      roles: [USER_ROLES.ADMIN],
    });
    const adminToken = generateAccessToken({
      sub: adminUser._id.toString(),
      roles: adminUser.roles,
    });
    const adminGetProfileRes = await fetch(`${baseUrl}/api/v1/users/${regResultA.user.id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    assert.equal(adminGetProfileRes.status, 200, "Admin requesting another user profile should return 200");
    const adminGetProfileJson = await adminGetProfileRes.json();
    assert.equal(adminGetProfileJson.success, true);
    assert.equal(adminGetProfileJson.data._id, regResultA.user.id);
    assert.equal(adminGetProfileJson.data.passwordHash, undefined, "Admin response must not contain passwordHash");

    // 5. Nonexistent user requested by ADMIN -> 404 User Not Found
    const fakeUserId = "507f1f77bcf86cd799439011";
    const notFoundProfileRes = await fetch(`${baseUrl}/api/v1/users/${fakeUserId}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    assert.equal(notFoundProfileRes.status, 404, "Nonexistent user should return 404");
    const notFoundProfileJson = await notFoundProfileRes.json();
    assert.equal(notFoundProfileJson.error.code, "USER_NOT_FOUND");
    console.log("✓ User Profile API security & IDOR/BOLA protections verified (401, 200 own, 403 cross-user, 200 admin, 404 nonexistent, no passwordHash)");

    // -------------------------------------------------------------
    // F09: Authentication Status Enforcement Security Tests
    // -------------------------------------------------------------
    console.log("\n[F09 Security] Testing Authentication Status Enforcement...");

    // Test F09-1: Valid JWT + ACTIVE user -> Succeeds (200)
    const activeStatusRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Authorization: `Bearer ${regResultA.accessToken}` },
    });
    assert.equal(activeStatusRes.status, 200, "Active user request must succeed with 200");
    console.log("✓ Valid ACTIVE user request succeeded with 200");

    // Test F09-2: Valid JWT + SUSPENDED user -> Rejected with 403 ACCOUNT_SUSPENDED
    const suspendedUser = await User.create({
      email: suspendedEmail,
      passwordHash: "dummyhash",
      status: USER_STATUSES.SUSPENDED,
      roles: [USER_ROLES.USER],
    });
    const suspendedToken = generateAccessToken({
      sub: suspendedUser._id.toString(),
      roles: suspendedUser.roles,
    });
    const suspendedRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Authorization: `Bearer ${suspendedToken}` },
    });
    assert.equal(suspendedRes.status, 403, "Suspended user must be rejected with 403");
    const suspendedJson = await suspendedRes.json();
    assert.equal(suspendedJson.error.code, "ACCOUNT_SUSPENDED");
    console.log("✓ Valid JWT + SUSPENDED user rejected with 403 ACCOUNT_SUSPENDED");

    // Test F09-3: Valid JWT + DISABLED user -> Rejected with 403 ACCOUNT_DISABLED
    const disabledUser = await User.create({
      email: disabledEmail,
      passwordHash: "dummyhash",
      status: USER_STATUSES.DISABLED,
      roles: [USER_ROLES.USER],
    });
    const disabledToken = generateAccessToken({
      sub: disabledUser._id.toString(),
      roles: disabledUser.roles,
    });
    const disabledRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Authorization: `Bearer ${disabledToken}` },
    });
    assert.equal(disabledRes.status, 403, "Disabled user must be rejected with 403");
    const disabledJson = await disabledRes.json();
    assert.equal(disabledJson.error.code, "ACCOUNT_DISABLED");
    console.log("✓ Valid JWT + DISABLED user rejected with 403 ACCOUNT_DISABLED");

    // Test F09-4: Valid JWT + Nonexistent user -> Rejected with 401 UNAUTHORIZED
    const nonexistentToken = generateAccessToken({
      sub: "507f1f77bcf86cd799439099",
      roles: [USER_ROLES.USER],
    });
    const nonexistentRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Authorization: `Bearer ${nonexistentToken}` },
    });
    assert.equal(nonexistentRes.status, 401, "Nonexistent user must be rejected with 401");
    const nonexistentJson = await nonexistentRes.json();
    assert.equal(nonexistentJson.error.code, "UNAUTHORIZED");
    console.log("✓ Valid JWT + Nonexistent user rejected with 401 UNAUTHORIZED");

    // Test F09-5: Invalid JWT -> Rejected with 401 UNAUTHORIZED
    const invalidJwtRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Authorization: "Bearer invalid.malformed.jwt" },
    });
    assert.equal(invalidJwtRes.status, 401, "Invalid JWT must be rejected with 401");
    const invalidJwtJson = await invalidJwtRes.json();
    assert.equal(invalidJwtJson.error.code, "UNAUTHORIZED");
    console.log("✓ Invalid JWT rejected with 401 UNAUTHORIZED");

    // Test F09-6: Missing JWT -> Rejected with 401 UNAUTHORIZED
    const missingJwtRes = await fetch(`${baseUrl}/api/v1/tokens/balance`);
    assert.equal(missingJwtRes.status, 401, "Missing JWT must be rejected with 401");
    const missingJwtJson = await missingJwtRes.json();
    assert.equal(missingJwtJson.error.code, "UNAUTHORIZED");
    console.log("✓ Missing JWT rejected with 401 UNAUTHORIZED");

    // 10c. Create Conversation
    const convCreateRes = await fetch(`${baseUrl}/api/v1/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
      body: JSON.stringify({ title: "Regression Test Conversation" }),
    });
    assert.equal(convCreateRes.status, 201, "Create conversation should return 201");
    const convJson = await convCreateRes.json();
    const conversationId = convJson.data._id;
    assert.ok(conversationId, "Conversation ID should exist");
    console.log("✓ Existing Conversation creation verified");

    // 10d. Create Message in Conversation
    const msgCreateRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
      body: JSON.stringify({ content: "Hello, this is a test message." }),
    });
    assert.equal(msgCreateRes.status, 201, "Create message should return 201");
    console.log("✓ Existing Message creation verified");

    // 10e. Get Conversation Messages
    const msgListRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`, {
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(msgListRes.status, 200, "Get messages should return 200");
    const msgListJson = await msgListRes.json();
    assert.equal(msgListJson.data.length, 1, "Should have 1 message");
    console.log("✓ Existing Message listing verified");

    // 10f. Archive Conversation
    const archiveRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(archiveRes.status, 200, "Archive conversation should return 200");
    const archiveJson = await archiveRes.json();
    assert.equal(archiveJson.data.status, "ARCHIVED");
    console.log("✓ Existing Archive conversation verified");

    // 10g. Unarchive Conversation
    const unarchiveRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/unarchive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(unarchiveRes.status, 200, "Unarchive conversation should return 200");
    const unarchiveJson = await unarchiveRes.json();
    assert.equal(unarchiveJson.data.status, "ACTIVE");
    console.log("✓ Existing Unarchive conversation verified");

    // 10h. Delete Conversation
    const deleteRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${regResultA.accessToken}`,
      },
    });
    assert.equal(deleteRes.status, 200, "Delete conversation should return 200");
    console.log("✓ Existing Delete conversation verified");

    console.log("\n==================================================");
    console.log(" ALL TESTS & REGRESSION CHECKS PASSED SUCCESSFULLY ");
    console.log("==================================================");
  } finally {
    // Cleanup test data
    try {
      const users = await User.find({
        email: { $in: [userAEmail, userBEmail, adminEmail, suspendedEmail, disabledEmail] },
      });
      const userIds = users.map((u) => u._id);

      if (userIds.length > 0) {
        await TokenBalance.deleteMany({ userId: { $in: userIds } });
        await Message.deleteMany({ userId: { $in: userIds } });
        await Conversation.deleteMany({ userId: { $in: userIds } });
        await User.deleteMany({ _id: { $in: userIds } });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
