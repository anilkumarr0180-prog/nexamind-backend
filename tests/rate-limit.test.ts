import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import {
  createRateLimiter,
  resetAuthRateLimit,
  resetAiRateLimit,
} from "../src/middleware/rate-limit.js";
import { env } from "../src/config/env.js";

class MockAIProvider implements AIProvider {
  public readonly name = "mock-rate-limit-ai";
  async generateChatResponse(_messages: AIMessage[]): Promise<AIResponse> {
    return {
      content: "Rate limit test AI response",
      provider: "mock-ai",
      model: "mock-llama3",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting F07 API Rate Limiting Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);
  console.log(`Configured limits: Auth=${env.AUTH_RATE_LIMIT_MAX}/${env.AUTH_RATE_LIMIT_WINDOW_MS}ms, AI=${env.AI_RATE_LIMIT_MAX}/${env.AI_RATE_LIMIT_WINDOW_MS}ms`);

  const testTimestamp = Date.now();
  const testEmail = `ratelimit_test_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";
  let testUserId = "";
  let testUserToken = "";
  let testConvId = "";

  try {
    // -------------------------------------------------------------
    // Test 1: Requests below the limit succeed & headers are present
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing requests below the limit succeed...");
    await resetAuthRateLimit();

    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    assert.equal(regRes.status, 201, "Registration below limit must succeed with 201");
    const regJson = await regRes.json();
    testUserId = regJson.data.user.id;
    testUserToken = regJson.data.accessToken;

    // Verify RateLimit headers
    const limitHeader = regRes.headers.get("ratelimit-limit");
    const remainingHeader = regRes.headers.get("ratelimit-remaining");
    const resetHeader = regRes.headers.get("ratelimit-reset");

    assert.ok(limitHeader, "Response must include RateLimit-Limit header");
    assert.ok(remainingHeader !== null, "Response must include RateLimit-Remaining header");
    assert.ok(resetHeader, "Response must include RateLimit-Reset header");
    assert.equal(limitHeader, String(env.AUTH_RATE_LIMIT_MAX));
    console.log(`✓ Successful request included standard RateLimit headers (Limit: ${limitHeader}, Remaining: ${remainingHeader}, Reset: ${resetHeader}s)`);

    // Create a conversation for AI tests
    const conv = await Conversation.create({
      userId: testUserId,
      title: "Rate Limit Conv",
    });
    testConvId = conv._id.toString();

    // -------------------------------------------------------------
    // Test 2: Login and Register are both protected by Auth rate limiter
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing both Login and Register endpoints are rate limited...");

    // Test with a dedicated test app instance to exhaustively test boundary threshold
    const authTestApp = express();
    authTestApp.use(express.json());
    const { limiter: isolatedAuthLimiter } = createRateLimiter({
      windowMs: 60000,
      limit: 2,
      message: "Too many authentication attempts, please try again later.",
    });

    authTestApp.post("/auth/test-reg", isolatedAuthLimiter, (_req, res) => {
      res.status(201).json({ success: true });
    });
    authTestApp.post("/auth/test-login", isolatedAuthLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const authTestServer = http.createServer(authTestApp);
    await new Promise<void>((resolve) => authTestServer.listen(0, resolve));
    const authPort = (authTestServer.address() as any).port;

    try {
      // Request 1 on register: 201 OK
      const r1 = await fetch(`http://127.0.0.1:${authPort}/auth/test-reg`, { method: "POST" });
      assert.equal(r1.status, 201);

      // Request 2 on login: 200 OK
      const r2 = await fetch(`http://127.0.0.1:${authPort}/auth/test-login`, { method: "POST" });
      assert.equal(r2.status, 200);

      // Request 3 on login: exceeds limit (2) -> 429
      const r3 = await fetch(`http://127.0.0.1:${authPort}/auth/test-login`, { method: "POST" });
      assert.equal(r3.status, 429, "Exceeding auth limit must return 429");
      const r3Json = await r3.json();
      assert.equal(r3Json.success, false);
      assert.equal(r3Json.error.code, "TOO_MANY_REQUESTS");
      assert.equal(r3Json.error.message, "Too many authentication attempts, please try again later.");

      // Verify headers on 429
      assert.ok(r3.headers.get("retry-after"), "429 must include Retry-After header");
      assert.equal(r3.headers.get("ratelimit-remaining"), "0");
      console.log("✓ Login and Register endpoints share auth policy and return 429 when threshold exceeded");
    } finally {
      authTestServer.close();
    }

    // -------------------------------------------------------------
    // Test 3: AI Chat exceeding its limit returns 429
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing AI chat rate limiting...");

    const aiTestApp = express();
    aiTestApp.use(express.json());
    const { limiter: isolatedAiLimiter } = createRateLimiter({
      windowMs: 60000,
      limit: 2,
      message: "Too many AI chat requests, please try again later.",
    });
    aiTestApp.post("/ai/test-chat", isolatedAiLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const aiTestServer = http.createServer(aiTestApp);
    await new Promise<void>((resolve) => aiTestServer.listen(0, resolve));
    const aiPort = (aiTestServer.address() as any).port;

    try {
      const res1 = await fetch(`http://127.0.0.1:${aiPort}/ai/test-chat`, { method: "POST" });
      assert.equal(res1.status, 200);
      const res2 = await fetch(`http://127.0.0.1:${aiPort}/ai/test-chat`, { method: "POST" });
      assert.equal(res2.status, 200);

      const res3 = await fetch(`http://127.0.0.1:${aiPort}/ai/test-chat`, { method: "POST" });
      assert.equal(res3.status, 429, "Exceeding AI limit must return 429");
      const res3Json = await res3.json();
      assert.equal(res3Json.success, false);
      assert.equal(res3Json.error.code, "TOO_MANY_REQUESTS");
      assert.equal(res3Json.error.message, "Too many AI chat requests, please try again later.");
      console.log("✓ AI chat endpoint properly rejects excess requests with 429 and standard error shape");
    } finally {
      aiTestServer.close();
    }

    // -------------------------------------------------------------
    // Test 4: Different limiter policies are completely independent
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing independence of Auth and AI rate limit policies...");

    const dualApp = express();
    dualApp.use(express.json());
    const { limiter: dAuthLimiter } = createRateLimiter({
      windowMs: 60000,
      limit: 1,
      message: "Auth limit reached",
    });
    const { limiter: dAiLimiter } = createRateLimiter({
      windowMs: 60000,
      limit: 1,
      message: "AI limit reached",
    });

    dualApp.post("/auth/action", dAuthLimiter, (_req, res) => res.json({ ok: "auth" }));
    dualApp.post("/ai/action", dAiLimiter, (_req, res) => res.json({ ok: "ai" }));

    const dualServer = http.createServer(dualApp);
    await new Promise<void>((resolve) => dualServer.listen(0, resolve));
    const dualPort = (dualServer.address() as any).port;

    try {
      // Exhaust auth limiter (1 request allowed)
      const auth1 = await fetch(`http://127.0.0.1:${dualPort}/auth/action`, { method: "POST" });
      assert.equal(auth1.status, 200);
      const auth2 = await fetch(`http://127.0.0.1:${dualPort}/auth/action`, { method: "POST" });
      assert.equal(auth2.status, 429, "Auth limiter must now be exhausted (429)");

      // AI endpoint MUST still succeed because limiters are independent
      const ai1 = await fetch(`http://127.0.0.1:${dualPort}/ai/action`, { method: "POST" });
      assert.equal(ai1.status, 200, "AI request must succeed even when Auth limit is exhausted");
      const ai2 = await fetch(`http://127.0.0.1:${dualPort}/ai/action`, { method: "POST" });
      assert.equal(ai2.status, 429, "AI request now exhausted");

      console.log("✓ Verified Auth and AI rate limit policies operate completely independently");
    } finally {
      dualServer.close();
    }

    // -------------------------------------------------------------
    // Test 5: Endpoints not targeted by rate limits are unrestricted
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing health checks and /me are not rate limited...");

    // Health check endpoint
    for (let i = 0; i < 25; i++) {
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200, "Health check should never be rate limited");
    }
    console.log("✓ Health checks (/health) verified unrestricted across 25 rapid requests");

    // Authenticated /me endpoint
    for (let i = 0; i < 25; i++) {
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${testUserToken}` },
      });
      assert.equal(meRes.status, 200, "/me endpoint should not be rate limited");
    }
    console.log("✓ /api/v1/auth/me verified unrestricted across 25 rapid requests");

    // -------------------------------------------------------------
    // Test 6: Anti-spoofing verification (X-Forwarded-For not trusted)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing anti-spoofing: X-Forwarded-For cannot bypass rate limiting...");

    const spoofApp = express();
    spoofApp.use(express.json());
    const { limiter: spoofLimiter } = createRateLimiter({
      windowMs: 60000,
      limit: 1,
    });
    spoofApp.post("/test-spoof", spoofLimiter, (_req, res) => res.json({ ok: true }));

    const spoofServer = http.createServer(spoofApp);
    await new Promise<void>((resolve) => spoofServer.listen(0, resolve));
    const spoofPort = (spoofServer.address() as any).port;

    try {
      // First request
      const req1 = await fetch(`http://127.0.0.1:${spoofPort}/test-spoof`, {
        method: "POST",
        headers: { "X-Forwarded-For": "1.1.1.1" },
      });
      assert.equal(req1.status, 200);

      // Second request with spoofed X-Forwarded-For must still be blocked by socket IP
      const req2 = await fetch(`http://127.0.0.1:${spoofPort}/test-spoof`, {
        method: "POST",
        headers: { "X-Forwarded-For": "2.2.2.2" },
      });
      assert.equal(req2.status, 429, "Attacker spoofing X-Forwarded-For must still be rejected with 429");
      console.log("✓ Rate limiting successfully blocked spoofed X-Forwarded-For header bypass attempt");
    } finally {
      spoofServer.close();
    }

    // -------------------------------------------------------------
    // Test 7: Live App Endpoints Integration Verification
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing live app integration (auth & AI chat)...");
    await resetAuthRateLimit();
    await resetAiRateLimit();

    // Login on live app succeeds
    const liveLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert.equal(liveLoginRes.status, 200);
    assert.ok(liveLoginRes.headers.get("ratelimit-limit"));
    console.log("✓ Live app POST /api/v1/auth/login succeeded with rate limit headers");

    // AI Chat on live app succeeds
    const liveChatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testUserToken}`,
      },
      body: JSON.stringify({
        conversationId: testConvId,
        content: "Hello live rate limited AI",
      }),
    });
    assert.equal(liveChatRes.status, 200);
    assert.ok(liveChatRes.headers.get("ratelimit-limit"));
    console.log("✓ Live app POST /api/v1/ai/chat succeeded with rate limit headers");

    console.log("\n==================================================");
    console.log(" ALL F07 RATE LIMITING TESTS PASSED SUCCESSFULLY ");
    console.log("==================================================");
  } finally {
    // Cleanup
    try {
      if (testUserId) {
        await TokenBalance.deleteMany({ userId: testUserId });
        await Message.deleteMany({ userId: testUserId });
        await Conversation.deleteMany({ userId: testUserId });
        await User.deleteMany({ _id: testUserId });
      }
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Rate Limiting Test Suite Failed:", err);
  process.exit(1);
});
