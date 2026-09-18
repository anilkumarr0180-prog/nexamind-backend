import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { GroqProvider } from "../src/modules/ai/providers/groq.provider.js";
import { AppError } from "../src/errors/app.error.js";
import { env } from "../src/config/env.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

type MockBehavior =
  | "groq_413_immediate"
  | "normal_stream"
  | "content_then_413";

class MockTestProvider implements AIProvider {
  public readonly name = "groq";
  public behavior: MockBehavior = "normal_stream";

  async generateChatResponse(_messages: AIMessage[]): Promise<AIResponse> {
    return {
      content: "Non-streaming mock response",
      provider: this.name,
      model: "mock-model",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    };
  }

  async *generateChatStream(
    _messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    if (this.behavior === "groq_413_immediate") {
      throw new AppError(
        "AI request is too large. Please start a new conversation or shorten the context.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }

    if (this.behavior === "normal_stream") {
      yield { content: "Normal chunk 1. ", model: "qwen/qwen3.8-27b" };
      yield { content: "Normal chunk 2.", model: "qwen/qwen3.8-27b" };
      yield {
        content: "",
        model: "qwen/qwen3.8-27b",
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        done: true,
      };
      return;
    }

    if (this.behavior === "content_then_413") {
      yield { content: "Initial partial content before 413 error.", model: "qwen/qwen3.8-27b" };
      throw new AppError(
        "AI request is too large. Please start a new conversation or shorten the context.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
  }
}

const parseSSEEvents = (raw: string): any[] => {
  const events: any[] = [];
  const parts = raw.split("\n\n");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
  }
  return events;
};

const runGroq413StreamingTests = async () => {
  console.log("=== Starting Groq 413 & Streaming Lifecycle Test Suite ===");

  // -------------------------------------------------------------
  // Test 1: GroqProvider Unit Test - 413 handling and NO recursive retry
  // -------------------------------------------------------------
  console.log("\n[Test 1] GroqProvider unit test - 413 throws REQUEST_TOO_LARGE without retry");
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  try {
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          error: {
            message: "Request Entity Too Large",
            code: 413,
          },
        }),
        {
          status: 413,
          statusText: "Request Entity Too Large",
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as any;

    const provider = new GroqProvider("mock-key", "qwen/qwen3.8-27b");

    // Test stream 413
    fetchCallCount = 0;
    let streamThrew413 = false;
    try {
      const gen = provider.generateChatStream([{ role: "user", content: "hello" }]);
      await gen.next();
    } catch (err: any) {
      assert.ok(err instanceof AppError, "Error must be instance of AppError");
      assert.equal(err.statusCode, 413, "Status code must be 413");
      assert.equal(err.code, "REQUEST_TOO_LARGE", "Error code must be REQUEST_TOO_LARGE");
      assert.ok(
        err.message.includes("AI request is too large"),
        "Error message must inform user request is too large",
      );
      streamThrew413 = true;
    }
    assert.ok(streamThrew413, "Stream must throw 413 AppError");
    assert.equal(fetchCallCount, 1, "Must NOT recursively retry 413 on another model (fetchCallCount === 1)");

    // Test non-stream 413
    fetchCallCount = 0;
    let responseThrew413 = false;
    try {
      await provider.generateChatResponse([{ role: "user", content: "hello" }]);
    } catch (err: any) {
      assert.ok(err instanceof AppError, "Error must be instance of AppError");
      assert.equal(err.statusCode, 413, "Status code must be 413");
      assert.equal(err.code, "REQUEST_TOO_LARGE", "Error code must be REQUEST_TOO_LARGE");
      responseThrew413 = true;
    }
    assert.ok(responseThrew413, "generateChatResponse must throw 413 AppError");
    assert.equal(fetchCallCount, 1, "Must NOT recursively retry 413 on another model (fetchCallCount === 1)");

    console.log("✓ Test 1 Passed: GroqProvider handles 413 with REQUEST_TOO_LARGE and strictly 1 fetch attempt");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------
  // Test 2: GroqProvider Unit Test - Context Budget Enforcement
  // -------------------------------------------------------------
  console.log("\n[Test 2] GroqProvider unit test - Messages budgeted to env.AI_MAX_CONTEXT_CHARS before dispatch");
  let capturedBody: any = null;

  try {
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const provider = new GroqProvider("mock-key");
    const hugeMessageContent = "A".repeat(env.AI_MAX_CONTEXT_CHARS + 5000);

    await provider.generateChatResponse([
      { role: "user", content: hugeMessageContent },
    ]);

    assert.ok(capturedBody, "Request body must be captured");
    assert.ok(Array.isArray(capturedBody.messages), "Messages must be an array");
    const serialized = JSON.stringify(capturedBody.messages);
    assert.ok(
      serialized.length <= env.AI_MAX_CONTEXT_CHARS,
      `Serialized messages (${serialized.length}) must stay within configured budget (${env.AI_MAX_CONTEXT_CHARS})`,
    );

    console.log(`✓ Test 2 Passed: Serialized messages stay within ${env.AI_MAX_CONTEXT_CHARS} budget`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Database and server setup for tests 3, 4, 5
  await connectDatabase();
  const mockProvider = new MockTestProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let testUserId: string | null = null;
  let conversationId: string | null = null;

  try {
    const reg = await authService.register({
      email: `groq413-${Date.now()}@example.com`,
      password: "Password123!",
      name: "Groq 413 Test User",
    });
    testUserId = reg.user.id;
    const authToken = reg.accessToken;

    await tokenService.refundCredits(testUserId, 50);

    const conv = await Conversation.create({
      userId: testUserId,
      title: "Groq 413 Test Conversation",
      status: "ACTIVE",
    });
    conversationId = conv._id.toString();

    // -------------------------------------------------------------
    // Test 3: Normal streaming completion
    // -------------------------------------------------------------
    console.log("\n[Test 3] Normal streaming completion (start -> chunks -> done)");
    mockProvider.behavior = "normal_stream";

    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Hello normal stream",
        stream: true,
      }),
    });

    assert.equal(res3.status, 200);
    const body3 = await res3.text();
    const events3 = parseSSEEvents(body3);

    const startEvent = events3.find((e) => e.type === "start");
    const chunkEvents = events3.filter((e) => e.type === "chunk");
    const doneEvent = events3.find((e) => e.type === "done");
    const errorEvent = events3.find((e) => e.type === "error");

    assert.ok(startEvent, "Stream must contain start event");
    assert.ok(chunkEvents.length >= 2, "Stream must contain chunk events");
    assert.ok(doneEvent, "Stream must contain done event");
    assert.equal(errorEvent, undefined, "Stream must NOT contain error events");

    console.log("✓ Test 3 Passed: Normal stream completed successfully with zero errors");

    // -------------------------------------------------------------
    // Test 4: Streaming error after start (zero content) -> 413, refund, user message failed
    // -------------------------------------------------------------
    console.log("\n[Test 4] Streaming error after start (zero content) -> 413, refund, message failed");
    mockProvider.behavior = "groq_413_immediate";

    const balanceBefore4 = await tokenService.getBalance(testUserId);

    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Oversized prompt that fails immediately",
        stream: true,
      }),
    });

    assert.equal(res4.status, 200);
    const body4 = await res4.text();
    const events4 = parseSSEEvents(body4);

    const startEvent4 = events4.find((e) => e.type === "start");
    const errorEvent4 = events4.find((e) => e.type === "error");
    const doneEvent4 = events4.find((e) => e.type === "done");

    assert.ok(startEvent4, "Stream must emit start event before error");
    assert.ok(errorEvent4, "Stream must emit error event");
    assert.equal(doneEvent4, undefined, "Stream must NOT emit done event");
    assert.equal(errorEvent4.error.statusCode, 413, "Error statusCode must be 413");
    assert.equal(errorEvent4.error.code, "REQUEST_TOO_LARGE", "Error code must be REQUEST_TOO_LARGE");
    assert.ok(
      !errorEvent4.error.message.includes("empty response"),
      "Must NEVER convert genuine 413 into empty response error",
    );

    // Verify credit refund
    const balanceAfter4 = await tokenService.getBalance(testUserId);
    assert.equal(
      balanceAfter4.balance,
      balanceBefore4.balance,
      "Credits must be refunded on zero-content 413 provider failure",
    );

    // Verify user message status is FAILED
    const failedUserMsg = await Message.findById(startEvent4.userMessage.id);
    assert.equal(failedUserMsg?.status, MESSAGE_STATUSES.FAILED, "User message must be marked FAILED");

    console.log("✓ Test 4 Passed: 413 after start properly refunded credits, marked user message FAILED, and emitted 413");

    // -------------------------------------------------------------
    // Test 5: Partial response handling (content then 413 failure)
    // -------------------------------------------------------------
    console.log("\n[Test 5] Partial response handling - content then 413 preserves partial text and re-throws 413");
    mockProvider.behavior = "content_then_413";

    const balanceBefore5 = await tokenService.getBalance(testUserId);

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Prompt that produces partial content then fails",
        stream: true,
      }),
    });

    assert.equal(res5.status, 200);
    const body5 = await res5.text();
    const events5 = parseSSEEvents(body5);

    const startEvent5 = events5.find((e) => e.type === "start");
    const chunkEvents5 = events5.filter((e) => e.type === "chunk");
    const errorEvent5 = events5.find((e) => e.type === "error");

    assert.ok(startEvent5, "Stream must emit start event");
    assert.ok(chunkEvents5.length > 0, "Stream must emit partial chunk before error");
    assert.ok(errorEvent5, "Stream must emit genuine error event");
    assert.equal(errorEvent5.error.statusCode, 413, "Error must be 413");

    // Partial response MUST be persisted in DB
    const assistantMessages = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    }).sort({ createdAt: -1 });

    const latestAssistant = assistantMessages[0];
    assert.ok(latestAssistant, "Assistant message must be persisted for partial response");
    assert.equal(
      latestAssistant.content,
      "Initial partial content before 413 error.",
      "Persisted assistant message must contain the partial content",
    );
    assert.equal(
      latestAssistant.status,
      MESSAGE_STATUSES.COMPLETED,
      "Partial message must be marked COMPLETED",
    );

    // Credit should NOT be refunded because meaningful content was produced
    const balanceAfter5 = await tokenService.getBalance(testUserId);
    assert.equal(
      balanceAfter5.balance,
      balanceBefore5.balance - 1,
      "Credits must be retained (not refunded) when meaningful content was generated",
    );

    console.log("✓ Test 5 Passed: Partial response correctly persisted, credits retained, and genuine 413 emitted");

    console.log("\n=============================================================");
    console.log("=== ALL GROQ 413 & STREAMING TESTS PASSED (5/5) =============");
    console.log("=============================================================\n");
  } finally {
    if (conversationId) {
      await Message.deleteMany({ conversationId });
      await Conversation.findByIdAndDelete(conversationId);
    }
    if (testUserId) {
      await TokenBalance.deleteOne({ userId: testUserId });
      await User.findByIdAndDelete(testUserId);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
};

runGroq413StreamingTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
