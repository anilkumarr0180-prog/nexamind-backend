import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User, USER_STATUSES } from "../src/modules/users/user.model.js";
import { RefreshToken } from "../src/modules/auth/refresh-token.model.js";
import { RefreshTokenRotationCache } from "../src/modules/auth/refresh-token-rotation-cache.model.js";
import {
  generateRefreshToken,
  hashToken,
} from "../src/modules/auth/refresh-token.util.js";
import {
  refreshSession,
  revokeSession,
} from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/utils/password.js";

const runTests = async () => {
  console.log("=== Starting NexaMind Authentication Renewal: Refresh & Safe Rotation Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5003;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const timestamp = Date.now();
  const createdUserIds: mongoose.Types.ObjectId[] = [];
  const allowedOrigin = env.CORS_ORIGINS[0] || "http://localhost:5173";

  try {
    // Helper to create an active test user
    const createTestUser = async (suffix: string, status = USER_STATUSES.ACTIVE) => {
      const user = await User.create({
        name: `User ${suffix}`,
        email: `test_${suffix}_${timestamp}@example.com`,
        passwordHash: await hashPassword("Password123!"),
        status,
      });
      createdUserIds.push(user._id);
      return user;
    };

    // Helper to issue an initial token in DB
    const createDbToken = async (
      user: { _id: mongoose.Types.ObjectId },
      clientType: "web" | "vscode",
      overrides: Partial<{
        isRevoked: boolean;
        revokedReason: string | null;
        expiresAt: Date;
        familyId: string;
      }> = {},
    ) => {
      const rawToken = generateRefreshToken();
      const tokenHash = hashToken(rawToken);
      const familyId = overrides.familyId || crypto.randomUUID();
      const expiresAt = overrides.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const doc = await RefreshToken.create({
        userId: user._id,
        tokenHash,
        familyId,
        clientType,
        isRevoked: overrides.isRevoked ?? false,
        revokedReason: overrides.revokedReason ?? null,
        expiresAt,
      });

      return { rawToken, tokenHash, doc, familyId };
    };

    // -------------------------------------------------------------
    // Test 1: Successful VS Code refresh and token rotation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing successful VS Code refresh and token rotation...");
    const user1 = await createTestUser("vscode_1");
    const { rawToken: vscodeToken1, tokenHash: vscodeHash1, familyId: family1 } =
      await createDbToken(user1, "vscode");

    const refreshRes1 = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: vscodeToken1 }),
    });

    assert.equal(refreshRes1.status, 200, "VS Code refresh should return 200");
    const json1 = await refreshRes1.json();
    assert.equal(json1.success, true);
    assert.ok(json1.data.accessToken, "Must return accessToken");
    assert.ok(json1.data.refreshToken, "Must return new refreshToken for VS Code");
    assert.notEqual(json1.data.refreshToken, vscodeToken1, "Must rotate to a new refresh token");
    assert.equal(json1.data.user.id, user1._id.toString());

    // Verify DB states: old token is marked ROTATED
    const oldDoc1 = await RefreshToken.findOne({ tokenHash: vscodeHash1 });
    assert.equal(oldDoc1?.isRevoked, true);
    assert.equal(oldDoc1?.revokedReason, "ROTATED");
    assert.equal(oldDoc1?.replacedByTokenHash, hashToken(json1.data.refreshToken));

    // Verify new token is persisted with matching familyId and clientType
    const newDoc1 = await RefreshToken.findOne({
      tokenHash: hashToken(json1.data.refreshToken),
    });
    assert.ok(newDoc1);
    assert.equal(newDoc1?.familyId, family1);
    assert.equal(newDoc1?.clientType, "vscode");
    assert.equal(newDoc1?.isRevoked, false);

    // Verify rotation cache record created
    const cacheDoc1 = await RefreshTokenRotationCache.findOne({
      originalTokenHash: vscodeHash1,
    });
    assert.ok(cacheDoc1, "Rotation cache must exist for the rotated token");
    console.log("✓ VS Code refresh successfully rotated token, updated DB, and populated rotation cache");

    // -------------------------------------------------------------
    // Test 2: Browser refresh through HttpOnly cookies without a refresh token in JSON
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing browser refresh through HttpOnly cookies...");
    const user2 = await createTestUser("browser_1");
    const { rawToken: browserToken1, tokenHash: browserHash1, familyId: family2 } =
      await createDbToken(user2, "web");

    const refreshRes2 = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Cookie: `nexamind_rt=${browserToken1}`,
      },
    });

    assert.equal(refreshRes2.status, 200, "Browser refresh should return 200");
    const json2 = await refreshRes2.json();
    assert.equal(json2.success, true);
    assert.ok(json2.data.accessToken);
    assert.equal(json2.data.refreshToken, undefined, "refreshToken must NEVER be in JSON for browser");
    assert.equal(json2.data.token, undefined);

    // Verify Set-Cookie header with rotated token
    const setCookie2 = refreshRes2.headers.get("set-cookie") || "";
    assert.ok(setCookie2.includes("nexamind_rt="), "Must set nexamind_rt cookie");
    assert.ok(setCookie2.toLowerCase().includes("httponly"));
    assert.ok(setCookie2.toLowerCase().includes("samesite=lax"));

    const newCookieMatch = setCookie2.match(/nexamind_rt=([^;]+)/);
    assert.ok(newCookieMatch);
    const newBrowserRawToken = newCookieMatch[1];
    assert.notEqual(newBrowserRawToken, browserToken1, "Rotated cookie token must be new");

    // Verify DB states for browser token
    const oldBrowserDoc = await RefreshToken.findOne({ tokenHash: browserHash1 });
    assert.equal(oldBrowserDoc?.isRevoked, true);
    assert.equal(oldBrowserDoc?.revokedReason, "ROTATED");

    const newBrowserDoc = await RefreshToken.findOne({
      tokenHash: hashToken(newBrowserRawToken),
    });
    assert.ok(newBrowserDoc);
    assert.equal(newBrowserDoc?.familyId, family2);
    assert.equal(newBrowserDoc?.clientType, "web");
    console.log("✓ Browser refresh rotated cookie without exposing refresh token in JSON response");

    // -------------------------------------------------------------
    // Test 3: Two concurrent refresh requests returning the same successor within grace period
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing concurrent refresh requests returning identical successor...");
    const user3 = await createTestUser("concurrent_1");
    const { rawToken: concurrentToken } = await createDbToken(user3, "vscode");

    // Fire two refreshSession requests simultaneously
    const [resA, resB] = await Promise.all([
      refreshSession({ token: concurrentToken, expectedClientType: "vscode" }),
      refreshSession({ token: concurrentToken, expectedClientType: "vscode" }),
    ]);

    assert.equal(resA.refreshToken, resB.refreshToken, "Both concurrent requests must receive the exact same successor token");
    assert.ok(resA.accessToken, "Request A must receive valid access token");
    assert.ok(resB.accessToken, "Request B must receive valid access token");

    // Check that exactly one successor token was created in MongoDB
    const successorDocs = await RefreshToken.find({
      userId: user3._id,
      isRevoked: false,
    });
    assert.equal(successorDocs.length, 1, "Exactly one successor token document should exist");
    assert.equal(successorDocs[0].tokenHash, hashToken(resA.refreshToken));
    console.log("✓ Concurrent refreshes cleanly resolved to identical successor without duplicate records or replay errors");

    // -------------------------------------------------------------
    // Test 4: Retrying after a successful rotation whose response was lost (retry during grace period)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing retry after lost response within 20s grace period...");
    const user4 = await createTestUser("lost_resp_1");
    const { rawToken: retryToken, tokenHash: retryHash } = await createDbToken(user4, "vscode");

    const t0 = 1700000000000;
    // Initial rotation at t0
    const initialResult = await refreshSession({
      token: retryToken,
      expectedClientType: "vscode",
      now: t0,
    });

    // Simulate lost response: Client retries sending the old token at t0 + 5 seconds (within 20s grace period)
    const retryResult = await refreshSession({
      token: retryToken,
      expectedClientType: "vscode",
      now: t0 + 5000,
    });

    assert.equal(
      retryResult.refreshToken,
      initialResult.refreshToken,
      "Retry within grace period must recover and return identical successor token",
    );
    assert.ok(retryResult.accessToken, "Must issue fresh access token on retry");

    // Successor token remains valid and unrevoked
    const successorDoc4 = await RefreshToken.findOne({
      tokenHash: hashToken(initialResult.refreshToken),
    });
    assert.equal(successorDoc4?.isRevoked, false, "Successor token must not be revoked during grace period");
    console.log("✓ Lost response recovery successfully returned cached successor during grace period");

    // -------------------------------------------------------------
    // Test 5: Genuine reuse after the grace period revoking the entire family
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing genuine reuse after grace period triggers token family revocation...");
    const user5 = await createTestUser("replay_1");
    const { rawToken: replayToken, familyId: replayFamily } = await createDbToken(user5, "vscode");

    const tReplay = 1700000000000;
    // Legitimate rotation at tReplay
    const rotation5 = await refreshSession({
      token: replayToken,
      expectedClientType: "vscode",
      now: tReplay,
    });

    // Successor token is currently valid
    const successorToken5 = rotation5.refreshToken;

    // Attacker presents the old token at tReplay + 25 seconds (past the 20s grace period)
    let replayError: any = null;
    try {
      await refreshSession({
        token: replayToken,
        expectedClientType: "vscode",
        now: tReplay + 25000,
      });
    } catch (err) {
      replayError = err;
    }

    assert.ok(replayError, "Replay attempt after grace period must be rejected");
    assert.equal(replayError.statusCode, 401);
    assert.equal(replayError.code, "REPLAY_ATTACK");

    // Verify that ALL tokens in the family are now revoked with REPLAY_ATTACK
    const familyDocs5 = await RefreshToken.find({ familyId: replayFamily });
    assert.ok(familyDocs5.length >= 2, "Family must contain old and successor tokens");
    for (const doc of familyDocs5) {
      assert.equal(doc.isRevoked, true, "Every token in family must be revoked");
      assert.equal(doc.revokedReason, "REPLAY_ATTACK");
    }

    // Attempting to refresh with the successor token must now ALSO fail
    let successorError: any = null;
    try {
      await refreshSession({
        token: successorToken5,
        expectedClientType: "vscode",
        now: tReplay + 26000,
      });
    } catch (err) {
      successorError = err;
    }
    assert.ok(successorError, "Successor token must be rejected after family revocation");
    assert.equal(successorError.code, "REVOKED_TOKEN");
    console.log("✓ Genuine reuse after grace period successfully detected and revoked entire token family");

    // -------------------------------------------------------------
    // Test 6: Logout revokes family and clears cookie; refresh fails
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing logout revokes token family and blocks refresh...");
    const user6 = await createTestUser("logout_1");
    const { rawToken: logoutWebToken, familyId: logoutFamily } = await createDbToken(user6, "web");

    // Logout via browser endpoint with cookie
    const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Cookie: `nexamind_rt=${logoutWebToken}`,
      },
    });

    assert.equal(logoutRes.status, 200, "Logout should return 200");
    const logoutJson = await logoutRes.json();
    assert.equal(logoutJson.success, true);

    // Verify cookie cleared
    const clearCookieHeader = logoutRes.headers.get("set-cookie") || "";
    assert.ok(clearCookieHeader.includes("nexamind_rt=;"), "Cookie must be cleared on logout");

    // Verify family marked LOGOUT
    const logoutDocs = await RefreshToken.find({ familyId: logoutFamily });
    assert.ok(logoutDocs.length > 0);
    for (const doc of logoutDocs) {
      assert.equal(doc.isRevoked, true);
      assert.equal(doc.revokedReason, "LOGOUT");
    }

    // Refresh with the logged-out token must fail
    let logoutRefreshError: any = null;
    try {
      await refreshSession({ token: logoutWebToken, expectedClientType: "web" });
    } catch (err) {
      logoutRefreshError = err;
    }
    assert.ok(logoutRefreshError);
    assert.equal(logoutRefreshError.code, "REVOKED_TOKEN");

    // Repeated logout calls are completely safe and idempotent
    const repeatLogoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Cookie: `nexamind_rt=${logoutWebToken}`,
      },
    });
    assert.equal(repeatLogoutRes.status, 200, "Repeated logout call must succeed idempotently");
    console.log("✓ Logout revoked token family, cleared cookie, blocked refresh, and proved idempotent");

    // -------------------------------------------------------------
    // Test 7: Expired, revoked, malformed, and suspended users
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing rejection of expired, revoked, malformed, and suspended credentials...");
    const user7 = await createTestUser("safety_1");

    // Expired token
    const { rawToken: expiredToken } = await createDbToken(user7, "vscode", {
      expiresAt: new Date(Date.now() - 60000), // 1 minute ago
    });
    await assert.rejects(
      () => refreshSession({ token: expiredToken, expectedClientType: "vscode" }),
      (err: any) => err.code === "TOKEN_EXPIRED",
      "Expired token must be rejected with TOKEN_EXPIRED",
    );

    // Explicitly revoked token
    const { rawToken: revokedToken } = await createDbToken(user7, "vscode", {
      isRevoked: true,
      revokedReason: "MANUAL_REVOCATION",
    });
    await assert.rejects(
      () => refreshSession({ token: revokedToken, expectedClientType: "vscode" }),
      (err: any) => err.code === "REVOKED_TOKEN",
      "Revoked token must be rejected with REVOKED_TOKEN",
    );

    // Malformed token format
    await assert.rejects(
      () => refreshSession({ token: "not_a_valid_hex_token", expectedClientType: "vscode" }),
      (err: any) => err.code === "INVALID_TOKEN",
      "Malformed token must be rejected with INVALID_TOKEN",
    );

    // Suspended user
    const suspendedUser = await createTestUser("suspended_refresh", USER_STATUSES.SUSPENDED);
    const { rawToken: suspendedToken } = await createDbToken(suspendedUser, "vscode");
    await assert.rejects(
      () => refreshSession({ token: suspendedToken, expectedClientType: "vscode" }),
      (err: any) => err.code === "ACCOUNT_SUSPENDED",
      "Suspended user must be rejected with ACCOUNT_SUSPENDED",
    );
    console.log("✓ Expired, revoked, malformed, and suspended accounts strictly rejected");

    // -------------------------------------------------------------
    // Test 8: Disallowed browser Origins and client channel enforcement
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing disallowed origins and cross-channel enforcement...");
    const user8 = await createTestUser("origin_1");
    const { rawToken: webToken8 } = await createDbToken(user8, "web");

    // Browser refresh with untrusted origin
    const badOriginRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted-attacker.com",
        Cookie: `nexamind_rt=${webToken8}`,
      },
    });
    assert.equal(badOriginRes.status, 403, "Untrusted origin must return 403 FORBIDDEN");

    // Cross-channel: Attempting to refresh a web token via body (VS Code mode)
    const crossChannelRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: webToken8 }), // web token sent to vscode channel
    });
    assert.equal(crossChannelRes.status, 401, "Cross-channel mismatch must return 401");
    console.log("✓ Disallowed origins and cross-channel token misuse strictly blocked");

    // -------------------------------------------------------------
    // Test 9: Renewal disabled behavior
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing renewal disabled fallback mode...");
    const originalSetting = env.AUTH_RENEWAL_ENABLED;
    try {
      (env as { AUTH_RENEWAL_ENABLED: boolean }).AUTH_RENEWAL_ENABLED = false;

      const disabledRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: vscodeToken1 }),
      });
      assert.equal(disabledRes.status, 503, "Refresh should return 503 when renewal is disabled");
      const disabledJson = await disabledRes.json();
      assert.equal(disabledJson.error.code, "FEATURE_DISABLED");
    } finally {
      (env as { AUTH_RENEWAL_ENABLED: boolean }).AUTH_RENEWAL_ENABLED = originalSetting;
    }
    console.log("✓ Renewal disabled gracefully returns 503 FEATURE_DISABLED");

    // -------------------------------------------------------------
    // Test 10: Logged-out session cannot be revived through cached rotation result
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing logged-out session cannot be revived through cached rotation...");
    const user10 = await createTestUser("no_revive_1");
    const { rawToken: reviveToken, familyId: reviveFamily } = await createDbToken(user10, "vscode");

    const tRevive = 1700000000000;
    // Legitimate rotation at tRevive
    await refreshSession({
      token: reviveToken,
      expectedClientType: "vscode",
      now: tRevive,
    });

    // User logs out at tRevive + 2 seconds (within the 20-second window)
    await revokeSession(reviveToken);

    // Try to present the old token at tRevive + 3 seconds (inside the 20s window)
    let reviveError: any = null;
    try {
      await refreshSession({
        token: reviveToken,
        expectedClientType: "vscode",
        now: tRevive + 3000,
      });
    } catch (err) {
      reviveError = err;
    }

    assert.ok(reviveError, "Must reject refresh on logged out session even inside grace window");
    assert.equal(reviveError.code, "REVOKED_TOKEN");
    console.log("✓ Logged-out session correctly blocked from revival inside rotation grace window");
  } finally {
    if (createdUserIds.length > 0) {
      await RefreshToken.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }

  console.log("\n=========================================================================");
  console.log(" ALL 10 AUTH REFRESH & TOKEN ROTATION TESTS PASSED! ");
  console.log("=========================================================================");
};

runTests().catch((error) => {
  console.error("Test execution failed:", error);
  process.exit(1);
});
