import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User, USER_STATUSES } from "../src/modules/users/user.model.js";
import { RefreshToken } from "../src/modules/auth/refresh-token.model.js";
import { AuthorizationCode } from "../src/modules/auth/authorization-code.model.js";
import { hashToken } from "../src/modules/auth/refresh-token.util.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { hashPassword } from "../src/utils/password.js";

const runTests = async () => {
  console.log("=== Starting NexaMind Authentication Renewal Test Suite (Phase 2.2) ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5002;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const timestamp = Date.now();
  const createdUserIds: mongoose.Types.ObjectId[] = [];

  const allowedBrowserOrigin = env.CORS_ORIGINS[0] || "http://localhost:5173";
  const untrustedOrigin = "https://malicious-attacker.com";
  const allowedVsCodeCallbackUri = env.VSCODE_ALLOWED_CALLBACK_URIS[0] || "vscode://nexamind.nexamind-vscode/auth";

  try {
    // -------------------------------------------------------------
    // Test 1: Browser registration issues nexamind_rt cookie without exposing refresh token in JSON
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing browser registration cookie issuance and response shape...");
    const regEmail = `browser_reg_${timestamp}@example.com`;
    const regPassword = "SecurePassword123!";

    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: allowedBrowserOrigin,
      },
      body: JSON.stringify({
        email: regEmail,
        password: regPassword,
        name: "Browser User",
      }),
    });

    assert.equal(regRes.status, 201, "Registration should return 201 Created");
    const regJson = await regRes.json();
    assert.equal(regJson.success, true);
    assert.ok(regJson.data.accessToken, "accessToken must be in JSON");
    assert.equal(regJson.data.refreshToken, undefined, "refreshToken must NEVER be in JSON response");
    assert.equal(regJson.data.token, undefined, "token must not be in JSON response");

    // Verify Set-Cookie header
    const setCookie = regRes.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes("nexamind_rt="), "nexamind_rt cookie must be present in Set-Cookie");
    assert.ok(setCookie.toLowerCase().includes("httponly"), "Cookie must be HttpOnly");
    assert.ok(setCookie.toLowerCase().includes("samesite=lax"), "Cookie must be SameSite=Lax");
    assert.ok(setCookie.includes("Path=/api/v1/auth"), "Cookie path must be /api/v1/auth");

    const userId = new mongoose.Types.ObjectId(regJson.data.user.id);
    createdUserIds.push(userId);

    // Verify RefreshToken persisted in MongoDB
    const persistedWebTokens = await RefreshToken.find({ userId, clientType: "web" });
    assert.equal(persistedWebTokens.length, 1, "Exactly one web refresh token document should be created");
    assert.equal(persistedWebTokens[0].isRevoked, false);
    assert.ok(persistedWebTokens[0].tokenHash, "tokenHash must be saved");

    // Extract cookie value and verify hash
    const cookieMatch = setCookie.match(/nexamind_rt=([^;]+)/);
    assert.ok(cookieMatch, "Cookie value must be extractable");
    const rawCookieToken = cookieMatch[1];
    assert.equal(rawCookieToken.length, 80, "Raw cookie token must be 80 hex characters");
    assert.equal(hashToken(rawCookieToken), persistedWebTokens[0].tokenHash, "Database hash must match cookie token SHA-256");
    console.log("✓ Browser registration correctly sets HttpOnly nexamind_rt cookie without exposing refresh token in JSON");

    // -------------------------------------------------------------
    // Test 2: Browser login sets nexamind_rt cookie
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing browser login cookie issuance...");
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: allowedBrowserOrigin,
      },
      body: JSON.stringify({
        email: regEmail,
        password: regPassword,
      }),
    });

    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.success, true);
    assert.ok(loginJson.data.accessToken);
    assert.equal(loginJson.data.refreshToken, undefined, "refreshToken must NEVER be in JSON response");

    const loginSetCookie = loginRes.headers.get("set-cookie") || "";
    assert.ok(loginSetCookie.includes("nexamind_rt="), "nexamind_rt cookie must be present on login");
    assert.ok(loginSetCookie.toLowerCase().includes("httponly"));
    console.log("✓ Browser login correctly issues nexamind_rt cookie");

    // -------------------------------------------------------------
    // Test 3: Disallowed origin or non-browser client does NOT receive cookie or refresh token in JSON
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing unapproved origin / non-browser request behavior...");
    const untrustedRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: untrustedOrigin,
      },
      body: JSON.stringify({
        email: regEmail,
        password: regPassword,
      }),
    });

    // CORS preflight or rejection, or if processed without allowed origin:
    const untrustedSetCookie = untrustedRes.headers.get("set-cookie");
    assert.equal(
      Boolean(untrustedSetCookie && untrustedSetCookie.includes("nexamind_rt")),
      false,
      "Untrusted origin must NEVER receive a refresh token cookie",
    );

    // Call without Origin header (e.g. extension or curl directly calling /login)
    const directRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NexaMind-Client": "vscode", // Caller supplied header
      },
      body: JSON.stringify({
        email: regEmail,
        password: regPassword,
      }),
    });

    assert.equal(directRes.status, 200);
    const directJson = await directRes.json();
    assert.ok(directJson.data.accessToken);
    assert.equal(directJson.data.refreshToken, undefined, "Caller-supplied header must NEVER cause refresh token in JSON");
    const directCookie = directRes.headers.get("set-cookie");
    assert.equal(directCookie, null, "Direct non-browser call must not receive a cookie");
    console.log("✓ Disallowed origin and caller-supplied headers do not receive cookies or refresh tokens");

    // -------------------------------------------------------------
    // Test 4: PKCE Authorization - Unauthenticated request rejected
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing PKCE authorization requires authentication...");
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 example
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const pkceState = "secure_random_state_12345678";

    const unauthAuthzRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codeChallenge,
        codeChallengeMethod: "S256",
        state: pkceState,
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(unauthAuthzRes.status, 401, "Unauthenticated request to /vscode/authorize must return 401");
    console.log("✓ PKCE authorization strictly requires valid authentication");

    // -------------------------------------------------------------
    // Test 5: PKCE Authorization - Valid request generates single-use code
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing valid PKCE authorization generates bound single-use code...");
    const userAccessToken = loginJson.data.accessToken;

    const authzRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAccessToken}`,
      },
      body: JSON.stringify({
        codeChallenge,
        codeChallengeMethod: "S256",
        state: pkceState,
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(authzRes.status, 200, "PKCE authorization should succeed with 200");
    const authzJson = await authzRes.json();
    assert.equal(authzJson.success, true);
    assert.ok(authzJson.data.code, "Authorization code must be returned");
    assert.equal(authzJson.data.state, pkceState, "State must match");
    assert.equal(authzJson.data.expiresIn, 300, "TTL must be 300 seconds");
    assert.ok(
      authzJson.data.redirectUri.startsWith(allowedVsCodeCallbackUri),
      "Redirect URI must start with allowed callback URI",
    );
    assert.ok(authzJson.data.redirectUri.includes(`code=${authzJson.data.code}`));
    assert.ok(authzJson.data.redirectUri.includes(`state=${pkceState}`));

    const rawAuthCode = authzJson.data.code;

    // Verify AuthorizationCode in MongoDB
    const authCodeHash = hashToken(rawAuthCode);
    const codeDoc = await AuthorizationCode.findOne({ codeHash: authCodeHash });
    assert.ok(codeDoc, "AuthorizationCode document must exist in database");
    assert.equal(codeDoc.userId.toString(), userId.toString());
    assert.equal(codeDoc.codeChallenge, codeChallenge);
    assert.equal(codeDoc.isUsed, false);
    assert.ok(codeDoc.expiresAt.getTime() > Date.now(), "Code must have future expiration");
    console.log("✓ PKCE authorization successfully issued 5-minute single-use code bound to user and challenge");

    // -------------------------------------------------------------
    // Test 6: PKCE Authorization - Arbitrary redirect destination rejected
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing rejection of arbitrary redirect destinations...");
    const badRedirectRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAccessToken}`,
      },
      body: JSON.stringify({
        codeChallenge,
        codeChallengeMethod: "S256",
        state: pkceState,
        redirectUri: "https://evil-site.com/steal-code",
      }),
    });

    assert.equal(badRedirectRes.status, 400, "Arbitrary redirect URI must be rejected with 400");
    const badRedirectJson = await badRedirectRes.json();
    assert.equal(badRedirectJson.error.code, "INVALID_REDIRECT_URI");
    console.log("✓ Arbitrary redirect URIs strictly rejected against configured allowlist");

    // -------------------------------------------------------------
    // Test 7: PKCE Exchange - Wrong verifier rejected
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing PKCE exchange rejects incorrect code verifier...");
    const test7AuthzRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAccessToken}`,
      },
      body: JSON.stringify({
        codeChallenge,
        codeChallengeMethod: "S256",
        state: "state_test7",
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });
    const test7AuthzJson = await test7AuthzRes.json();
    const test7Code = test7AuthzJson.data.code;

    const wrongVerifierRes = await fetch(`${baseUrl}/api/v1/auth/vscode/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: test7Code,
        codeVerifier: "wrong_verifier_1234567890123456789012345678901234",
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(wrongVerifierRes.status, 400, "Wrong code verifier must return 400");
    const wrongVerifierJson = await wrongVerifierRes.json();
    assert.equal(wrongVerifierJson.error.code, "INVALID_GRANT");
    console.log("✓ Incorrect PKCE code verifier correctly rejected");

    // -------------------------------------------------------------
    // Test 8: PKCE Exchange - Successful exchange returns user, accessToken, and refreshToken
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing successful PKCE exchange...");
    const exchangeRes = await fetch(`${baseUrl}/api/v1/auth/vscode/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: rawAuthCode,
        codeVerifier: codeVerifier,
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(exchangeRes.status, 200, "PKCE exchange should succeed with 200");
    const exchangeJson = await exchangeRes.json();
    assert.equal(exchangeJson.success, true);
    assert.ok(exchangeJson.data.accessToken, "accessToken must be returned");
    assert.ok(exchangeJson.data.refreshToken, "refreshToken must be returned for VS Code");
    assert.equal(exchangeJson.data.user.id, userId.toString(), "User ID must match");
    assert.equal(exchangeJson.data.refreshToken.length, 80, "Refresh token must be 80 hex chars");

    // Check that authorization code was marked isUsed = true
    const consumedCodeDoc = await AuthorizationCode.findOne({ codeHash: authCodeHash });
    assert.equal(consumedCodeDoc?.isUsed, true, "Code must be atomically marked isUsed = true");
    assert.ok(consumedCodeDoc?.usedAt, "usedAt timestamp must be set");

    // Check that RefreshToken was persisted with clientType: "vscode"
    const extensionTokenHash = hashToken(exchangeJson.data.refreshToken);
    const extensionTokenDoc = await RefreshToken.findOne({ tokenHash: extensionTokenHash });
    assert.ok(extensionTokenDoc, "Extension refresh token must be in database");
    assert.equal(extensionTokenDoc?.clientType, "vscode", "Client type must be vscode");
    assert.equal(extensionTokenDoc?.userId.toString(), userId.toString());
    console.log("✓ PKCE exchange successfully issued VS Code refresh token and atomically consumed code");

    // -------------------------------------------------------------
    // Test 9: PKCE Exchange - Replay / Reuse attack prevention
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing replay / reuse attack prevention on consumed authorization code...");
    const replayRes = await fetch(`${baseUrl}/api/v1/auth/vscode/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: rawAuthCode,
        codeVerifier: codeVerifier,
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(replayRes.status, 400, "Replaying a consumed code must be rejected with 400");
    const replayJson = await replayRes.json();
    assert.equal(replayJson.error.code, "INVALID_GRANT");
    assert.match(replayJson.error.message, /already been used/i);
    console.log("✓ Replay of consumed authorization code strictly rejected with INVALID_GRANT");

    // -------------------------------------------------------------
    // Test 10: PKCE Exchange - Expired code rejection
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing rejection of expired authorization code...");
    const expiredRawCode = crypto.randomBytes(32).toString("base64url");
    await AuthorizationCode.create({
      userId,
      codeHash: hashToken(expiredRawCode),
      codeChallenge,
      codeChallengeMethod: "S256",
      state: "state_123",
      redirectUri: allowedVsCodeCallbackUri,
      expiresAt: new Date(Date.now() - 10000), // Expired 10 seconds ago
      isUsed: false,
    });

    const expiredRes = await fetch(`${baseUrl}/api/v1/auth/vscode/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: expiredRawCode,
        codeVerifier: codeVerifier,
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(expiredRes.status, 400, "Expired code must be rejected with 400");
    const expiredJson = await expiredRes.json();
    assert.equal(expiredJson.error.code, "INVALID_GRANT");
    assert.match(expiredJson.error.message, /expired/i);
    console.log("✓ Expired authorization code strictly rejected with INVALID_GRANT");

    // -------------------------------------------------------------
    // Test 11: Suspended user cannot authorize or exchange
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing suspended user is blocked from PKCE flow...");
    const suspendedUser = await User.create({
      name: "Suspended User",
      email: `suspended_${timestamp}@example.com`,
      passwordHash: await hashPassword("Password123!"),
      status: USER_STATUSES.SUSPENDED,
    });
    createdUserIds.push(suspendedUser._id);

    const suspendedToken = generateAccessToken({
      sub: suspendedUser._id.toString(),
      roles: suspendedUser.roles,
    });

    const suspendedAuthzRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${suspendedToken}`,
      },
      body: JSON.stringify({
        codeChallenge,
        codeChallengeMethod: "S256",
        state: "state_suspended",
        redirectUri: allowedVsCodeCallbackUri,
      }),
    });

    assert.equal(suspendedAuthzRes.status, 403, "Suspended user must be blocked with 403");
    console.log("✓ Suspended user correctly blocked with 403 ACCOUNT_SUSPENDED");

    // -------------------------------------------------------------
    // Test 12: Renewal disabled fallback mode
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing renewal disabled fallback mode...");
    const originalRenewalSetting = env.AUTH_RENEWAL_ENABLED;
    try {
      (env as { AUTH_RENEWAL_ENABLED: boolean }).AUTH_RENEWAL_ENABLED = false;

      // Existing login still succeeds
      const fallbackLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: allowedBrowserOrigin,
        },
        body: JSON.stringify({
          email: regEmail,
          password: regPassword,
        }),
      });
      assert.equal(fallbackLoginRes.status, 200);
      const fallbackSetCookie = fallbackLoginRes.headers.get("set-cookie");
      assert.equal(
        Boolean(fallbackSetCookie && fallbackSetCookie.includes("nexamind_rt")),
        false,
        "No cookie when renewal is disabled",
      );

      // PKCE endpoints return 503 FEATURE_DISABLED
      const disabledAuthzRes = await fetch(`${baseUrl}/api/v1/auth/vscode/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAccessToken}`,
        },
        body: JSON.stringify({
          codeChallenge,
          codeChallengeMethod: "S256",
          state: "state_disabled",
          redirectUri: allowedVsCodeCallbackUri,
        }),
      });
      assert.equal(disabledAuthzRes.status, 503);
      const disabledJson = await disabledAuthzRes.json();
      assert.equal(disabledJson.error.code, "FEATURE_DISABLED");
      console.log("✓ Existing auth works and PKCE gracefully disables when AUTH_RENEWAL_ENABLED is false");
    } finally {
      (env as { AUTH_RENEWAL_ENABLED: boolean }).AUTH_RENEWAL_ENABLED = originalRenewalSetting;
    }
  } finally {
    // Cleanup test data
    if (createdUserIds.length > 0) {
      await RefreshToken.deleteMany({ userId: { $in: createdUserIds } });
      await AuthorizationCode.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }

  console.log("\n=========================================================================");
  console.log(" ALL 12 PHASE 2.2 AUTH RENEWAL & PKCE TESTS PASSED! ");
  console.log("=========================================================================");
};

runTests().catch((error) => {
  console.error("Test execution failed:", error);
  process.exit(1);
});
