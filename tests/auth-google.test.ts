import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User, USER_STATUSES } from "../src/modules/users/user.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import { verifyAccessToken } from "../src/utils/jwt.js";
import {
  validateGooglePayloadClaims,
  defaultGoogleTokenVerifier,
  setGoogleTokenVerifier,
  resetGoogleTokenVerifier,
  type GoogleVerifiedPayload,
} from "../src/modules/auth/google.verifier.js";
import { AppError } from "../src/errors/app.error.js";

const runTests = async () => {
  console.log("=== Starting Google Sign-In Verification Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5001;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const testClientId = "test-google-client-id-12345.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_ID = testClientId;

  try {
    // =========================================================================
    // PART 1: Google Verifier & Claims Validation Unit Tests
    // =========================================================================
    console.log("\n--- Part 1: Token Claims & Verifier Unit Tests ---");

    // Test 1: Invalid token (malformed string) rejected by default verifier
    console.log("\n[Test 1] Testing invalid/malformed token rejection via google-auth-library verifier...");
    await assert.rejects(
      async () => {
        await defaultGoogleTokenVerifier("malformed.jwt.token", testClientId);
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "INVALID_GOOGLE_TOKEN");
        return true;
      },
      "Malformed token must be rejected with 401 INVALID_GOOGLE_TOKEN",
    );
    console.log("✓ Malformed token correctly rejected by google-auth-library verifier");

    // Test 2: Expired token
    console.log("\n[Test 2] Testing expired token claim validation...");
    assert.throws(
      () => {
        validateGooglePayloadClaims(
          {
            iss: "accounts.google.com",
            aud: testClientId,
            exp: Math.floor(Date.now() / 1000) - 300, // 5 mins ago
            sub: "google-sub-expired",
            email: "expired@example.com",
          },
          testClientId,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "GOOGLE_TOKEN_EXPIRED");
        return true;
      },
      "Expired token must throw GOOGLE_TOKEN_EXPIRED",
    );
    console.log("✓ Expired token correctly rejected with 401 GOOGLE_TOKEN_EXPIRED");

    // Test 3: Wrong audience
    console.log("\n[Test 3] Testing audience mismatch claim validation...");
    assert.throws(
      () => {
        validateGooglePayloadClaims(
          {
            iss: "https://accounts.google.com",
            aud: "wrong-client-id.apps.googleusercontent.com",
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: "google-sub-aud",
            email: "aud@example.com",
          },
          testClientId,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "INVALID_GOOGLE_TOKEN");
        return true;
      },
      "Audience mismatch must throw INVALID_GOOGLE_TOKEN",
    );
    console.log("✓ Wrong audience correctly rejected with 401 INVALID_GOOGLE_TOKEN");

    // Test 4: Invalid issuer
    console.log("\n[Test 4] Testing invalid issuer claim validation...");
    assert.throws(
      () => {
        validateGooglePayloadClaims(
          {
            iss: "https://untrusted-issuer.com",
            aud: testClientId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: "google-sub-iss",
            email: "iss@example.com",
          },
          testClientId,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "INVALID_GOOGLE_TOKEN");
        return true;
      },
      "Invalid issuer must throw INVALID_GOOGLE_TOKEN",
    );
    console.log("✓ Invalid issuer correctly rejected with 401 INVALID_GOOGLE_TOKEN");

    // Test 5: Missing sub
    console.log("\n[Test 5] Testing missing sub claim validation...");
    assert.throws(
      () => {
        validateGooglePayloadClaims(
          {
            iss: "accounts.google.com",
            aud: testClientId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: "   ",
            email: "missing-sub@example.com",
          },
          testClientId,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "INVALID_GOOGLE_TOKEN");
        return true;
      },
      "Missing sub must throw INVALID_GOOGLE_TOKEN",
    );
    console.log("✓ Missing sub correctly rejected with 401 INVALID_GOOGLE_TOKEN");

    // Test 6: Valid claims parsed correctly
    console.log("\n[Test 6] Testing valid claims parsed correctly...");
    const validClaims = validateGooglePayloadClaims(
      {
        iss: "https://accounts.google.com",
        aud: testClientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "google-sub-valid-12345",
        email: "VALID.USER@Example.COM",
        email_verified: true,
        name: " Valid User ",
        picture: "https://example.com/avatar.jpg",
      },
      testClientId,
    );
    assert.equal(validClaims.sub, "google-sub-valid-12345");
    assert.equal(validClaims.email, "valid.user@example.com");
    assert.equal(validClaims.name, "Valid User");
    assert.equal(validClaims.picture, "https://example.com/avatar.jpg");
    assert.equal(validClaims.emailVerified, true);
    console.log("✓ Valid claims correctly normalized and parsed");

    // =========================================================================
    // PART 2: API End-to-End Tests (POST /api/v1/auth/google)
    // =========================================================================
    console.log("\n--- Part 2: API End-to-End Verification ---");

    // Test 7: Validation error on empty or missing credential
    console.log("\n[Test 7] Testing 400 Bad Request on missing credential...");
    const resEmpty = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(resEmpty.status, 400);
    const jsonEmpty = await resEmpty.json();
    assert.equal(jsonEmpty.success, false);
    console.log("✓ Missing credential rejected with 400 Bad Request");

    // Test 8: Invalid token rejected via API
    console.log("\n[Test 8] Testing invalid token rejected via API...");
    const resInvalid = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "bad.signature.token" }),
    });
    assert.equal(resInvalid.status, 401);
    const jsonInvalid = await resInvalid.json();
    assert.equal(jsonInvalid.success, false);
    assert.equal(jsonInvalid.error.code, "INVALID_GOOGLE_TOKEN");
    console.log("✓ Invalid token rejected via API with 401 INVALID_GOOGLE_TOKEN");

    // Configure mock verifier for predictable deterministic API scenario tests
    let mockResult: GoogleVerifiedPayload | null = null;
    let mockError: AppError | null = null;

    setGoogleTokenVerifier(async () => {
      if (mockError) {
        throw mockError;
      }
      if (mockResult) {
        return mockResult;
      }
      throw new AppError("Invalid Google credential", 401, "INVALID_GOOGLE_TOKEN");
    });

    // Test 9: Expired token rejected via API
    console.log("\n[Test 9] Testing expired token rejected via API...");
    mockError = new AppError("Google token has expired", 401, "GOOGLE_TOKEN_EXPIRED");
    const resExpired = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "expired-token" }),
    });
    assert.equal(resExpired.status, 401);
    const jsonExpired = await resExpired.json();
    assert.equal(jsonExpired.error.code, "GOOGLE_TOKEN_EXPIRED");
    console.log("✓ Expired token rejected via API with 401 GOOGLE_TOKEN_EXPIRED");
    mockError = null;

    // Test 10: Wrong audience rejected via API
    console.log("\n[Test 10] Testing wrong audience rejected via API...");
    mockError = new AppError("Google token audience mismatch", 401, "INVALID_GOOGLE_TOKEN");
    const resAud = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "wrong-aud-token" }),
    });
    assert.equal(resAud.status, 401);
    const jsonAud = await resAud.json();
    assert.equal(jsonAud.error.code, "INVALID_GOOGLE_TOKEN");
    console.log("✓ Wrong audience rejected via API with 401 INVALID_GOOGLE_TOKEN");
    mockError = null;

    // Test 11: Missing sub rejected via API
    console.log("\n[Test 11] Testing missing sub rejected via API...");
    mockError = new AppError("Google token missing required subject (sub)", 401, "INVALID_GOOGLE_TOKEN");
    const resSub = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "no-sub-token" }),
    });
    assert.equal(resSub.status, 401);
    const jsonSub = await resSub.json();
    assert.equal(jsonSub.error.code, "INVALID_GOOGLE_TOKEN");
    console.log("✓ Missing sub rejected via API with 401 INVALID_GOOGLE_TOKEN");
    mockError = null;

    // Test 12: New Google user provisioning
    console.log("\n[Test 12] Testing new Google user provisioning flow...");
    const googleSub1 = `google_sub_${timestamp}_1`;
    const googleEmail1 = `google_user_${timestamp}_1@example.com`;
    const googleName1 = "Maya Lin";

    mockResult = {
      sub: googleSub1,
      email: googleEmail1,
      emailVerified: true,
      name: googleName1,
      picture: "https://lh3.googleusercontent.com/a/avatar1",
    };

    const resNewGoogle = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "valid-google-cred-1" }),
    });

    assert.equal(resNewGoogle.status, 200, "Google sign-in should return 200 OK");
    const jsonNewGoogle = await resNewGoogle.json();
    assert.equal(jsonNewGoogle.success, true);
    assert.ok(jsonNewGoogle.data.accessToken, "Should return NexaMind accessToken");
    assert.ok(jsonNewGoogle.data.user.id, "Should return safe user id");
    assert.equal(jsonNewGoogle.data.user.email, googleEmail1);
    assert.equal(jsonNewGoogle.data.user.name, googleName1);
    assert.equal(jsonNewGoogle.data.user.passwordHash, undefined, "passwordHash must never be exposed");

    const newUserId = jsonNewGoogle.data.user.id;
    createdUserIds.push(newUserId);

    // Verify database document
    const userInDb = await User.findById(newUserId);
    assert.ok(userInDb, "User must exist in MongoDB");
    assert.equal(userInDb.googleId, googleSub1, "googleId must be stored in database");
    assert.equal(userInDb.email, googleEmail1);
    assert.equal(userInDb.passwordHash, undefined, "User provisioned with Google should not have passwordHash");

    // Verify access token validity
    const decodedToken = verifyAccessToken(jsonNewGoogle.data.accessToken);
    assert.equal(decodedToken.sub, newUserId, "Access token subject must match user ID");
    console.log("✓ New Google user provisioned successfully with NexaMind accessToken and SafeUser");

    // Test 13: TokenBalance initialization for new Google user
    console.log("\n[Test 13] Testing TokenBalance initialization (100 free credits)...");
    const balanceResult = await tokenService.getBalance(newUserId);
    assert.equal(balanceResult.balance, 100, "Initial token balance must be 100 credits");

    // Test idempotency: calling initializeBalance again must not overwrite
    const idempotentBalance = await tokenService.initializeBalance(newUserId, 500);
    assert.equal(idempotentBalance.balance, 100, "Idempotent call must not overwrite existing balance");
    console.log("✓ Token balance initialized to 100 credits and idempotent service confirmed");

    // Test 14: Existing Google user sign-in
    console.log("\n[Test 14] Testing existing Google user sign-in...");
    const resExistingGoogle = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "valid-google-cred-1-repeat" }),
    });

    assert.equal(resExistingGoogle.status, 200, "Existing Google user sign in should return 200 OK");
    const jsonExistingGoogle = await resExistingGoogle.json();
    assert.equal(jsonExistingGoogle.success, true);
    assert.equal(
      jsonExistingGoogle.data.user.id,
      newUserId,
      "Existing Google user ID must match the previously created user ID",
    );
    assert.ok(jsonExistingGoogle.data.accessToken, "Should return new access token");

    // Verify lastLoginAt was updated
    const userAfterLogin = await User.findById(newUserId);
    assert.ok(userAfterLogin?.lastLoginAt, "lastLoginAt should be set on login");
    console.log("✓ Existing Google user logs in seamlessly using googleId sub match");

    // Test 15: No auto-merging with existing local account (Requirement 8)
    console.log("\n[Test 15] Testing rejection of auto-merge with local account on email match...");
    const localEmail = `local_user_${timestamp}@example.com`;
    const localPassword = "SecureLocalPass123!";

    const regLocalRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: localEmail,
        password: localPassword,
        name: "Local User",
      }),
    });
    assert.equal(regLocalRes.status, 201);
    const regLocalJson = await regLocalRes.json();
    const localUserId = regLocalJson.data.user.id;
    createdUserIds.push(localUserId);

    // Now attempt Google login with SAME email but a NEW Google sub
    mockResult = {
      sub: `google_sub_different_${timestamp}`,
      email: localEmail,
      emailVerified: true,
      name: "Different Google Identity",
      picture: null,
    };

    const resCollision = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "colliding-email-token" }),
    });

    assert.equal(
      resCollision.status,
      409,
      "Auto-merging without linking must be rejected with 409 Conflict",
    );
    const jsonCollision = await resCollision.json();
    assert.equal(jsonCollision.success, false);
    assert.equal(jsonCollision.error.code, "USER_ALREADY_EXISTS");
    console.log("✓ Mismatched identity with existing local email safely rejected (no auto-merge)");

    // Test 16: Existing local login still works unchanged (Requirement 9)
    console.log("\n[Test 16] Testing existing local email/password login still works...");
    const localLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: localEmail,
        password: localPassword,
      }),
    });
    assert.equal(localLoginRes.status, 200);
    const localLoginJson = await localLoginRes.json();
    assert.equal(localLoginJson.success, true);
    assert.equal(localLoginJson.data.user.id, localUserId);
    console.log("✓ Local email/password login succeeds unchanged");

    // Test 17: Google-only user cannot log in via password endpoint
    console.log("\n[Test 17] Testing Google-only user cannot log in via password endpoint...");
    const googleUserPasswordLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: googleEmail1,
        password: "ArbitraryPassword123!",
      }),
    });
    assert.equal(googleUserPasswordLogin.status, 401);
    const googleUserPassJson = await googleUserPasswordLogin.json();
    assert.equal(googleUserPassJson.error.code, "INVALID_CREDENTIALS");
    console.log("✓ Google-only user rejected on password login with 401 INVALID_CREDENTIALS");

    // Test 18: Authenticated /api/v1/auth/me works with Google-provided access token
    console.log("\n[Test 18] Testing /api/v1/auth/me with access token from Google sign-in...");
    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${jsonNewGoogle.data.accessToken}` },
    });
    assert.equal(meRes.status, 200);
    const meJson = await meRes.json();
    assert.equal(meJson.data.id, newUserId);
    assert.equal(meJson.data.email, googleEmail1);
    assert.equal(meJson.data.name, googleName1);
    console.log("✓ /api/v1/auth/me works seamlessly with access token from Google sign-in");

    // Test 19: Suspended Google user rejected
    console.log("\n[Test 19] Testing suspended Google user rejected on login...");
    await User.findByIdAndUpdate(newUserId, { status: USER_STATUSES.SUSPENDED });
    mockResult = {
      sub: googleSub1,
      email: googleEmail1,
      emailVerified: true,
      name: googleName1,
      picture: null,
    };
    const resSuspended = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "suspended-cred" }),
    });
    assert.equal(resSuspended.status, 403);
    const jsonSuspended = await resSuspended.json();
    assert.equal(jsonSuspended.error.code, "ACCOUNT_SUSPENDED");
    console.log("✓ Suspended Google user correctly blocked with 403 ACCOUNT_SUSPENDED");

    console.log("\n=======================================================");
    console.log(" ALL 19 GOOGLE SIGN-IN VERIFICATION TESTS PASSED! ");
    console.log("=======================================================\n");
  } finally {
    resetGoogleTokenVerifier();
    console.log(`Cleaning up ${createdUserIds.length} test user records...`);
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await TokenBalance.deleteMany({ userId: { $in: createdUserIds } });
    }
    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
