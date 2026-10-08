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
import { resetAuthRateLimit } from "../src/middleware/rate-limit.js";

const runTests = async () => {
  console.log("=== Starting Google Sign-In Verification Test Suite ===");
  await connectDatabase();
  await User.init();

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
    await resetAuthRateLimit();
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

    // =========================================================================
    // PART 3: Safe Explicit Google Account Linking (Step 5 Verification)
    // =========================================================================
    await resetAuthRateLimit();
    console.log("\n--- Part 3: Explicit Account Linking & Conflict Tests (Step 5) ---");

    const linkEmail = `local_link_${timestamp}@example.com`;
    const linkPassword = "SecurePassLink123!";
    const linkGoogleSub = `google_link_sub_${timestamp}`;

    // Create a local email/password user
    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: linkEmail,
        password: linkPassword,
        name: "Linking Test User",
      }),
    });
    assert.equal(regRes.status, 201);
    const regJson = await regRes.json();
    const linkUserId = regJson.data.user.id;
    const linkUserToken = regJson.data.accessToken;
    createdUserIds.push(linkUserId);

    // Test 20: Unauthenticated linking attempt rejected
    console.log("\n[Test 20] Testing unauthenticated linking attempt rejected with 401...");
    const resUnauthedLink = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "any-google-token" }),
    });
    assert.equal(resUnauthedLink.status, 401);
    const jsonUnauthedLink = await resUnauthedLink.json();
    assert.equal(jsonUnauthedLink.error.code, "UNAUTHORIZED");
    console.log("✓ Unauthenticated linking attempt correctly rejected with 401 UNAUTHORIZED");

    // Test 21: Invalid Google credential on linking rejected
    console.log("\n[Test 21] Testing invalid Google credential on linking rejected with 401...");
    mockError = new AppError("Invalid Google token: bad signature", 401, "INVALID_GOOGLE_TOKEN");
    const resInvalidCredLink = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linkUserToken}`,
      },
      body: JSON.stringify({ credential: "bad-google-token" }),
    });
    assert.equal(resInvalidCredLink.status, 401);
    const jsonInvalidCredLink = await resInvalidCredLink.json();
    assert.equal(jsonInvalidCredLink.error.code, "INVALID_GOOGLE_TOKEN");
    console.log("✓ Invalid Google credential on linking rejected with 401 INVALID_GOOGLE_TOKEN");
    mockError = null;

    // Test 22: Successful explicit linking for existing local user
    console.log("\n[Test 22] Testing successful explicit Google account linking...");
    mockResult = {
      sub: linkGoogleSub,
      email: "google_profile_email@example.com",
      emailVerified: true,
      name: "Google Profile Name",
      picture: "https://example.com/pic.jpg",
    };

    const resExplicitLink = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linkUserToken}`,
      },
      body: JSON.stringify({ credential: "valid-linking-credential" }),
    });
    assert.equal(resExplicitLink.status, 200);
    const jsonExplicitLink = await resExplicitLink.json();
    assert.equal(jsonExplicitLink.success, true);
    assert.equal(jsonExplicitLink.data.user.id, linkUserId);
    assert.equal(jsonExplicitLink.data.user.isGoogleLinked, true);

    // Verify in database
    const linkedUserInDb = await User.findById(linkUserId);
    assert.ok(linkedUserInDb);
    assert.equal(linkedUserInDb.googleId, linkGoogleSub);
    console.log("✓ Google account explicitly linked using stable sub");

    // Test 23: Already-linked identity rejected
    console.log("\n[Test 23] Testing already-linked identity rejected on re-link attempt...");
    const resAlreadyLinked = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linkUserToken}`,
      },
      body: JSON.stringify({ credential: "already-linked-credential" }),
    });
    assert.equal(resAlreadyLinked.status, 409);
    const jsonAlreadyLinked = await resAlreadyLinked.json();
    assert.equal(jsonAlreadyLinked.error.code, "GOOGLE_ALREADY_LINKED");
    console.log("✓ Re-linking same Google identity safely rejected with 409 GOOGLE_ALREADY_LINKED");

    // Test 24: Google identity linked to another user rejected
    console.log("\n[Test 24] Testing Google identity already linked to another user rejected...");
    const userDEmail = `local_user_d_${timestamp}@example.com`;
    const regUserD = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userDEmail,
        password: "UserDPassword123!",
        name: "User D",
      }),
    });
    assert.equal(regUserD.status, 201);
    const userDJson = await regUserD.json();
    const userDId = userDJson.data.user.id;
    const userDToken = userDJson.data.accessToken;
    createdUserIds.push(userDId);

    // User D attempts to link linkGoogleSub (which belongs to linkUserId)
    const resConflictOther = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userDToken}`,
      },
      body: JSON.stringify({ credential: "stolen-google-sub" }),
    });
    assert.equal(resConflictOther.status, 409);
    const jsonConflictOther = await resConflictOther.json();
    assert.equal(jsonConflictOther.error.code, "GOOGLE_ACCOUNT_IN_USE");

    const userDInDb = await User.findById(userDId);
    assert.equal(userDInDb?.googleId ?? null, null);
    console.log("✓ Google identity already linked elsewhere safely rejected with 409 GOOGLE_ACCOUNT_IN_USE");

    // Test 25: Same-email local account conflict when not explicitly linking
    console.log("\n[Test 25] Testing same-email local account conflict during unauthenticated sign-in...");
    const userEEmail = `unlinked_user_e_${timestamp}@example.com`;
    const regUserE = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userEEmail,
        password: "UserEPassword123!",
        name: "User E",
      }),
    });
    assert.equal(regUserE.status, 201);
    const userEJson = await regUserE.json();
    createdUserIds.push(userEJson.data.user.id);

    // Unauthenticated Google sign-in with same email but new sub
    mockResult = {
      sub: `google_unlinked_sub_${timestamp}`,
      email: userEEmail,
      emailVerified: true,
      name: "Unlinked Google Identity",
      picture: null,
    };
    const resNoAutoMerge = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "unlinked-email-cred" }),
    });
    assert.equal(resNoAutoMerge.status, 409);
    const jsonNoAutoMerge = await resNoAutoMerge.json();
    assert.equal(jsonNoAutoMerge.error.code, "USER_ALREADY_EXISTS");

    const userEInDb = await User.findById(userEJson.data.user.id);
    assert.equal(userEInDb?.googleId ?? null, null, "User E must NOT be auto-merged");
    console.log("✓ Same-email local account conflict safely returns 409 without auto-merging");

    // Test 26: Existing local login still works after linking
    console.log("\n[Test 26] Testing local email/password login still works after Google linking...");
    const resLocalLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: linkEmail,
        password: linkPassword,
      }),
    });
    assert.equal(resLocalLogin.status, 200);
    const jsonLocalLogin = await resLocalLogin.json();
    assert.equal(jsonLocalLogin.success, true);
    assert.equal(jsonLocalLogin.data.user.id, linkUserId);
    console.log("✓ Local email/password login succeeds unchanged after linking");

    // Test 27: Google login works for the linked user
    console.log("\n[Test 27] Testing Google login works for the explicitly linked user...");
    mockResult = {
      sub: linkGoogleSub,
      email: "google_profile_email@example.com",
      emailVerified: true,
      name: "Google Profile Name",
      picture: null,
    };
    const resLinkedGoogleLogin = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "linked-google-login-cred" }),
    });
    assert.equal(resLinkedGoogleLogin.status, 200);
    const jsonLinkedGoogleLogin = await resLinkedGoogleLogin.json();
    assert.equal(jsonLinkedGoogleLogin.success, true);
    assert.equal(jsonLinkedGoogleLogin.data.user.id, linkUserId);
    console.log("✓ Google login succeeds seamlessly for explicitly linked user");

    // =========================================================================
    // PART 4: Production & Security Hardening Tests (Step 6)
    // =========================================================================
    await resetAuthRateLimit();
    console.log("\n--- Part 4: Production & Security Hardening Verification (Step 6) ---");

    // Test 28: CORS origin hardening on Google Auth endpoint
    console.log("\n[Test 28] Testing CORS origin enforcement on /api/v1/auth/google...");
    const corsAllowedRes = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5173",
      },
      body: JSON.stringify({ credential: "any-credential" }),
    });
    assert.equal(
      corsAllowedRes.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
      "Configured origin must receive Access-Control-Allow-Origin header",
    );
    assert.equal(
      corsAllowedRes.headers.get("access-control-allow-credentials"),
      "true",
      "Credentials header must be present for configured origin",
    );

    const corsBlockedRes = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://unauthorized-attacker.com",
      },
      body: JSON.stringify({ credential: "any-credential" }),
    });
    assert.equal(
      corsBlockedRes.headers.get("access-control-allow-origin"),
      null,
      "Unauthorized origin must NOT receive Access-Control-Allow-Origin header",
    );
    console.log("✓ CORS headers strictly enforce configured origins on Google auth endpoints");

    // Test 29: Token claim verification on linking (wrong audience & wrong issuer)
    console.log("\n[Test 29] Testing token claim forgery rejection on /google/link...");
    mockError = new AppError("Google token audience mismatch", 401, "INVALID_GOOGLE_TOKEN");
    const resAudMismatch = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userDToken}`,
      },
      body: JSON.stringify({ credential: "token-with-wrong-audience" }),
    });
    assert.equal(resAudMismatch.status, 401);
    const jsonAudMismatch = await resAudMismatch.json();
    assert.equal(jsonAudMismatch.error.code, "INVALID_GOOGLE_TOKEN");
    mockError = null;

    mockError = new AppError("Invalid Google token issuer", 401, "INVALID_GOOGLE_TOKEN");
    const resIssMismatch = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userDToken}`,
      },
      body: JSON.stringify({ credential: "token-with-wrong-issuer" }),
    });
    assert.equal(resIssMismatch.status, 401);
    const jsonIssMismatch = await resIssMismatch.json();
    assert.equal(jsonIssMismatch.error.code, "INVALID_GOOGLE_TOKEN");
    mockError = null;
    console.log("✓ Wrong audience and issuer are strictly rejected on linking");

    // Test 30: Untrusted frontend claims (name, email, roles) strictly ignored
    console.log("\n[Test 30] Testing untrusted frontend fields ignored during Google authentication...");
    const hardenedGoogleSub = `google_hardened_${timestamp}`;
    const verifiedGoogleEmail = `verified_google_${timestamp}@example.com`;
    mockResult = {
      sub: hardenedGoogleSub,
      email: verifiedGoogleEmail,
      emailVerified: true,
      name: "Verified Google Name",
      picture: null,
    };

    // Client attempts to pass spoofed email, sub, and admin role in request body
    const resSpoofed = await fetch(`${baseUrl}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: "valid-hardened-credential",
        email: "spoofed-admin@nexamind.ai",
        sub: "spoofed-sub",
        roles: ["ADMIN"],
      }),
    });
    assert.equal(resSpoofed.status, 200);
    const jsonSpoofed = await resSpoofed.json();
    const spoofedUserId = jsonSpoofed.data.user.id;
    createdUserIds.push(spoofedUserId);

    // Verify database record has verified Google email and sub, NOT spoofed ones
    const spoofedUserInDb = await User.findById(spoofedUserId);
    assert.ok(spoofedUserInDb);
    assert.equal(spoofedUserInDb.email, verifiedGoogleEmail, "Database email must match verified token, not body");
    assert.equal(spoofedUserInDb.googleId, hardenedGoogleSub, "Database googleId must match verified sub, not body");
    assert.deepEqual(spoofedUserInDb.roles, ["USER"], "Roles must default to USER, body roles must be ignored");
    console.log("✓ Untrusted frontend claims (email, sub, roles) safely ignored in favor of verified claims");

    // Test 31: MongoDB engine-level unique index on googleId blocks duplicates
    console.log("\n[Test 31] Testing database unique index enforcement on googleId...");
    let duplicateIndexCaught = false;
    try {
      await User.create({
        email: `duplicate_test_${timestamp}@example.com`,
        googleId: hardenedGoogleSub, // already in DB from Test 30
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        duplicateIndexCaught = true;
      }
    }
    assert.equal(duplicateIndexCaught, true, "MongoDB unique index must throw E11000 on duplicate googleId");
    console.log("✓ MongoDB unique index on googleId enforced at database engine level");

    // Test 32: Rate limiting headers present on /google/link endpoint
    console.log("\n[Test 32] Testing rate limiting headers on /google/link...");
    const resRateLimitHeader = await fetch(`${baseUrl}/api/v1/auth/google/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userDToken}`,
      },
      body: JSON.stringify({ credential: "dummy-cred" }),
    });
    // Rate limit headers must be attached
    assert.ok(
      resRateLimitHeader.headers.has("ratelimit-limit"),
      "Response must include ratelimit-limit header",
    );
    console.log("✓ Rate limiting headers active and verified on Google linking endpoint");

    console.log("\n=========================================================================");
    console.log(" ALL 32 GOOGLE SIGN-IN, LINKING & SECURITY HARDENING TESTS PASSED! ");
    console.log("=========================================================================\n");
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
