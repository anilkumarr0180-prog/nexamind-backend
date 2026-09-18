import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import { verifyPassword } from "../src/utils/password.js";
import { verifyAccessToken } from "../src/utils/jwt.js";

const runTests = async () => {
  console.log("=== Starting Auth Registration UX & Safety Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5001;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const timestamp = Date.now();
  const createdUserIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Successful registration with name, email, password via API
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing successful registration with name/email/password via API...");
    const validEmail = `auth_reg_${timestamp}_1@example.com`;
    const validPassword = "SecurePassword123!";
    const validName = "Alex Morgan";

    const res1 = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: validName,
        email: validEmail,
        password: validPassword,
      }),
    });

    assert.equal(res1.status, 201, "API registration should return 201 Created");
    const json1 = await res1.json();
    assert.equal(json1.success, true, "Response should indicate success");
    assert.ok(json1.data.user.id, "User ID should be present");
    assert.equal(json1.data.user.name, validName, "User name should match input");
    assert.equal(json1.data.user.email, validEmail.toLowerCase(), "Email should be lowercased");
    assert.equal(json1.data.user.passwordHash, undefined, "passwordHash must NEVER be exposed in response");
    assert.ok(json1.data.accessToken, "accessToken should be returned");

    const userId1 = json1.data.user.id;
    createdUserIds.push(userId1);
    console.log("✓ API registration with name succeeded and returned SafeUser with name");

    // -------------------------------------------------------------
    // Test 2: Password hashing & MongoDB persistence verification
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing password hashing & MongoDB persistence...");
    const userInDb = await User.findById(userId1).select("+passwordHash");
    assert.ok(userInDb, "User document must exist in MongoDB");
    assert.equal(userInDb.name, validName, "Name must be persisted in database");
    assert.equal(userInDb.email, validEmail.toLowerCase(), "Email must be persisted in database");
    assert.ok(userInDb.passwordHash, "passwordHash must exist in database");
    assert.notEqual(userInDb.passwordHash, validPassword, "Password must NOT be stored in plaintext");
    assert.ok(userInDb.passwordHash.startsWith("$argon2"), "Password must be hashed with Argon2");

    const isPasswordValid = await verifyPassword(validPassword, userInDb.passwordHash);
    assert.equal(isPasswordValid, true, "Stored hash must verify against original password");
    console.log("✓ Password is confirmed hashed with Argon2 and name is persisted in MongoDB");

    // -------------------------------------------------------------
    // Test 3: Token balance creation (automatic 100 credits initialization)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing token balance creation...");
    const balanceResult = await tokenService.getBalance(userId1);
    assert.equal(balanceResult.balance, 100, "Initial token balance should be 100 credits");
    console.log("✓ User token balance initialized to 100 credits");

    // -------------------------------------------------------------
    // Test 4: Token validity & automatic authentication via /api/v1/auth/me
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing access token validity & automatic authentication...");
    const decodedToken = verifyAccessToken(json1.data.accessToken);
    assert.equal(decodedToken.sub, userId1, "Token subject must match user ID");

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${json1.data.accessToken}` },
    });
    assert.equal(meRes.status, 200, "/api/v1/auth/me must return 200 OK");
    const meJson = await meRes.json();
    assert.equal(meJson.success, true);
    assert.equal(meJson.data.id, userId1);
    assert.equal(meJson.data.name, validName, "/me must return the user's name");
    assert.equal(meJson.data.email, validEmail.toLowerCase());
    console.log("✓ Access token allows immediate authenticated access with full user profile");

    // -------------------------------------------------------------
    // Test 5: Invalid Name validations
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing rejection of invalid names...");

    // 5a. Empty string name
    const emptyNameRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "",
        email: `invalid_name_${timestamp}_1@example.com`,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(emptyNameRes.status, 400, "Empty string name must return 400");

    // 5b. Whitespace only name
    const spaceNameRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "     ",
        email: `invalid_name_${timestamp}_2@example.com`,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(spaceNameRes.status, 400, "Whitespace only name must return 400");

    // 5c. Name exceeding 100 characters
    const longNameRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "A".repeat(101),
        email: `invalid_name_${timestamp}_3@example.com`,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(longNameRes.status, 400, "Excessively long name (>100 chars) must return 400");

    // 5d. Non-string name
    const nonStringNameRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: 12345,
        email: `invalid_name_${timestamp}_4@example.com`,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(nonStringNameRes.status, 400, "Non-string name must return 400");
    console.log("✓ All invalid name attempts correctly rejected with 400 Bad Request");

    // -------------------------------------------------------------
    // Test 6: Invalid Email validations
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing rejection of invalid emails...");
    const invalidEmailRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "notanemail",
        password: "ValidPassword123!",
      }),
    });
    assert.equal(invalidEmailRes.status, 400, "Malformed email must return 400");

    const missingEmailRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        password: "ValidPassword123!",
      }),
    });
    assert.equal(missingEmailRes.status, 400, "Missing email must return 400");
    console.log("✓ Invalid email attempts correctly rejected with 400");

    // -------------------------------------------------------------
    // Test 7: Invalid Password validations
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing rejection of invalid passwords...");
    const shortPasswordRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `short_pw_${timestamp}@example.com`,
        password: "short",
      }),
    });
    assert.equal(shortPasswordRes.status, 400, "Password under 8 characters must return 400");

    const longPasswordRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `long_pw_${timestamp}@example.com`,
        password: "p".repeat(129),
      }),
    });
    assert.equal(longPasswordRes.status, 400, "Password exceeding 128 characters must return 400");
    console.log("✓ Invalid password attempts correctly rejected with 400");

    // -------------------------------------------------------------
    // Test 8: Duplicate Email rejection (409 Conflict)
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing duplicate email rejection...");
    const dupRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Another Person",
        email: validEmail, // already registered in Test 1
        password: "AnotherPassword123!",
      }),
    });
    assert.equal(dupRes.status, 409, "Duplicate email registration must return 409 Conflict");
    const dupJson = await dupRes.json();
    assert.equal(dupJson.success, false);
    assert.equal(dupJson.error.code, "USER_ALREADY_EXISTS");
    console.log("✓ Duplicate email registration correctly rejected with 409 USER_ALREADY_EXISTS");

    // -------------------------------------------------------------
    // Test 9: Backward compatibility - registration without name
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing registration without name (backward compatibility)...");
    const legacyEmail = `legacy_reg_${timestamp}@example.com`;
    const legacyRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: legacyEmail,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(legacyRes.status, 201, "Registration without name must succeed for legacy consumers");
    const legacyJson = await legacyRes.json();
    assert.equal(legacyJson.data.user.name, null, "Omitted name should safely resolve to null");
    createdUserIds.push(legacyJson.data.user.id);
    console.log("✓ Registration without name succeeds with name: null");

    // -------------------------------------------------------------
    // Test 10: Existing user login compatibility
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing existing user login compatibility...");
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: validEmail,
        password: validPassword,
      }),
    });
    assert.equal(loginRes.status, 200, "Login must return 200 OK");
    const loginJson = await loginRes.json();
    assert.equal(loginJson.data.user.name, validName, "Login must return persisted name");
    assert.ok(loginJson.data.accessToken, "Login must return accessToken");

    const legacyLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: legacyEmail,
        password: "ValidPassword123!",
      }),
    });
    assert.equal(legacyLoginRes.status, 200, "Legacy user login must return 200 OK");
    const legacyLoginJson = await legacyLoginRes.json();
    assert.equal(legacyLoginJson.data.user.name, null, "Legacy user login handles missing name safely");
    console.log("✓ Existing users and newly registered users can log in without issues");

    // -------------------------------------------------------------
    // Test 11: Direct authService.register unit call with name trimming
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing direct authService.register call with trimmed name...");
    const serviceEmail = `service_reg_${timestamp}@example.com`;
    const serviceResult = await authService.register({
      name: "   Trimmed Name   ",
      email: serviceEmail,
      password: "ValidPassword123!",
    });
    assert.equal(serviceResult.user.name, "Trimmed Name", "Service must trim whitespace from name");
    createdUserIds.push(serviceResult.user.id);
    console.log("✓ authService.register successfully trims name");

    console.log("\n=======================================================");
    console.log(" ALL 11 AUTH REGISTRATION TESTS PASSED SUCCESSFULLY ");
    console.log("=======================================================\n");
  } finally {
    // Teardown created test records
    if (createdUserIds.length > 0) {
      console.log(`Cleaning up ${createdUserIds.length} test user records...`);
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await TokenBalance.deleteMany({ userId: { $in: createdUserIds } });
    }
    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Auth registration test failed:", err);
  process.exit(1);
});
