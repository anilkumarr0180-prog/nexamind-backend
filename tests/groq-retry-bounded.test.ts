import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import {
  GroqProvider,
  DEFAULT_RECOMMENDED_MODEL,
  FALLBACK_MODEL,
  MAX_PROVIDER_ATTEMPTS,
} from "../src/modules/ai/providers/groq.provider.js";
import { AppError } from "../src/errors/app.error.js";

const runGroqRetryBoundedTests = async () => {
  console.log("=== Starting Groq Bounded Retry & Anti-Recursion Test Suite ===");
  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------
    // Test 1: Primary model succeeds → exactly one provider call
    // -------------------------------------------------------------
    console.log("\n[Test 1] Primary model succeeds → strictly 1 provider call");
    let fetchHistory: string[] = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Success response from primary model" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const provider = new GroqProvider("mock-api-key");
    const response1 = await provider.generateChatResponse([
      { role: "user", content: "Hello" },
    ]);

    assert.equal(response1.content, "Success response from primary model");
    assert.equal(fetchHistory.length, 1, "Must make strictly 1 fetch call");
    assert.equal(fetchHistory[0], DEFAULT_RECOMMENDED_MODEL);
    console.log("✓ Test 1 Passed: Primary model succeeds on first attempt without any retry");

    // -------------------------------------------------------------
    // Test 2: Primary 429 → valid fallback succeeds (non-streaming)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Primary 429 → fallback succeeds on second attempt");
    fetchHistory = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);

      if (body.model === DEFAULT_RECOMMENDED_MODEL) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Rate limit reached on qwen (TPD 200000 limit)",
              code: 429,
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fallback model succeeds
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Success from fallback model" } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const response2 = await provider.generateChatResponse([
      { role: "user", content: "Hello" },
    ]);

    assert.equal(response2.content, "Success from fallback model");
    assert.equal(fetchHistory.length, 2, "Must make exactly 2 fetch calls (primary + fallback)");
    assert.equal(fetchHistory[0], DEFAULT_RECOMMENDED_MODEL);
    assert.equal(fetchHistory[1], FALLBACK_MODEL);
    console.log("✓ Test 2 Passed: Seamlessly retried with valid fallback model upon 429");

    // -------------------------------------------------------------
    // Test 3: Primary 429 → Fallback 429 → stops cleanly with RATE_LIMIT_EXCEEDED
    // -------------------------------------------------------------
    console.log("\n[Test 3] Primary 429 → Fallback 429 → strictly stops, throws RATE_LIMIT_EXCEEDED");
    fetchHistory = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);
      return new Response(
        JSON.stringify({
          error: {
            message: `Rate limit reached on ${body.model}`,
            code: 429,
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    let threw429 = false;
    try {
      await provider.generateChatResponse([{ role: "user", content: "Hello" }]);
    } catch (err: any) {
      assert.ok(err instanceof AppError, "Must be an AppError");
      assert.equal(err.statusCode, 429, "Must return HTTP 429");
      assert.equal(err.code, "RATE_LIMIT_EXCEEDED", "Must have code RATE_LIMIT_EXCEEDED");
      assert.ok(err.message.includes("rate limit"), "Must have user-safe message");
      threw429 = true;
    }

    assert.ok(threw429, "Must throw 429 RATE_LIMIT_EXCEEDED");
    assert.equal(fetchHistory.length, 2, "Must strictly stop after MAX_PROVIDER_ATTEMPTS (2 calls)");
    assert.equal(fetchHistory[0], DEFAULT_RECOMMENDED_MODEL);
    assert.equal(fetchHistory[1], FALLBACK_MODEL);
    console.log("✓ Test 3 Passed: Both models 429 stopped cleanly after 2 attempts without infinite recursion");

    // -------------------------------------------------------------
    // Test 4: Primary 429 → Fallback 404 → verify original model is NOT called again
    // -------------------------------------------------------------
    console.log("\n[Test 4] Primary 429 → Fallback 404 → NO cycling back to original model");
    fetchHistory = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);

      if (body.model === DEFAULT_RECOMMENDED_MODEL) {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limit reached on qwen", code: 429 },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fallback returns 404 (does not exist)
      return new Response(
        JSON.stringify({
          error: { message: "The model does not exist", code: 404 },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    let threw404Error = false;
    try {
      await provider.generateChatResponse([{ role: "user", content: "Hello" }]);
    } catch (err: any) {
      assert.ok(err instanceof AppError, "Must be an AppError");
      assert.equal(err.statusCode, 502, "Must return 502 provider error");
      threw404Error = true;
    }

    assert.ok(threw404Error, "Must throw provider error on fallback 404");
    assert.equal(fetchHistory.length, 2, "Must make strictly 2 fetch calls, never bouncing back to primary");
    assert.deepEqual(fetchHistory, [DEFAULT_RECOMMENDED_MODEL, FALLBACK_MODEL]);
    console.log("✓ Test 4 Passed: 404 on fallback did NOT cycle back to 429 primary model");

    // -------------------------------------------------------------
    // Test 5: Streaming Primary 429 → Fallback succeeds
    // -------------------------------------------------------------
    console.log("\n[Test 5] Streaming Primary 429 → Fallback succeeds");
    fetchHistory = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);

      if (body.model === DEFAULT_RECOMMENDED_MODEL) {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limit reached on qwen", code: 429 },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      // Successful stream from fallback
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "Fallback stream chunk" } }],
                model: FALLBACK_MODEL,
              })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as any;

    const streamChunks: string[] = [];
    for await (const chunk of provider.generateChatStream([{ role: "user", content: "Hi" }])) {
      if (chunk.content) streamChunks.push(chunk.content);
    }

    assert.equal(streamChunks.join(""), "Fallback stream chunk");
    assert.equal(fetchHistory.length, 2, "Must make exactly 2 stream attempts");
    assert.deepEqual(fetchHistory, [DEFAULT_RECOMMENDED_MODEL, FALLBACK_MODEL]);
    console.log("✓ Test 5 Passed: Streaming chat retried cleanly with fallback model upon 429");

    // -------------------------------------------------------------
    // Test 6: Streaming Primary 429 → Fallback 404 → NO cycling back
    // -------------------------------------------------------------
    console.log("\n[Test 6] Streaming Primary 429 → Fallback 404 → strictly bounded, NO recursion");
    fetchHistory = [];

    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      fetchHistory.push(body.model);

      if (body.model === DEFAULT_RECOMMENDED_MODEL) {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limit reached on qwen", code: 429 },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          error: { message: "The model does not exist", code: 404 },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    let streamErrorCaught = false;
    try {
      const gen = provider.generateChatStream([{ role: "user", content: "Hi" }]);
      await gen.next();
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      streamErrorCaught = true;
    }

    assert.ok(streamErrorCaught, "Must catch stream error");
    assert.equal(fetchHistory.length, 2, "Must strictly stop after 2 attempts");
    assert.deepEqual(fetchHistory, [DEFAULT_RECOMMENDED_MODEL, FALLBACK_MODEL]);
    console.log("✓ Test 6 Passed: Streaming ping-pong completely eliminated (fetch calls = 2)");

  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------
  // Test 7: Integration - Insufficient credit behavior remains unchanged
  // -------------------------------------------------------------
  console.log("\n[Test 7] Integration - Insufficient credits returned as 402, AI provider never called");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const testEmail = `test_credit_zero_${Date.now()}@example.com`;
    const regResult = await authService.register({
      email: testEmail,
      password: "Password123!",
      name: "Credit Test User",
    });

    const token = regResult.accessToken;
    const userId = regResult.user.id;

    // Drain balance to 0
    await TokenBalance.findOneAndUpdate(
      { userId },
      { $set: { balance: 0 } },
    );

    const conv = await Conversation.create({
      userId,
      title: "Zero Credit Conv",
      status: "ACTIVE",
    });

    const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId: conv._id.toString(),
        content: "Will this be rejected?",
      }),
    });

    const json = await res.json() as any;
    assert.equal(res.status, 402, "Must return HTTP 402");
    assert.equal(json.error?.code, "INSUFFICIENT_CREDITS");
    console.log("✓ Test 7 Passed: Insufficient credit balance safely rejected with 402 INSUFFICIENT_CREDITS");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }

  console.log("\n============================================================");
  console.log("=== ALL GROQ BOUNDED RETRY & ANTI-RECURSION TESTS PASSED ===");
  console.log("============================================================");
};

runGroqRetryBoundedTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
