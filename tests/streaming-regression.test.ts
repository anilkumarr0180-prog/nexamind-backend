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
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

type StreamBehavior =
  | "content_then_empty_chunk"
  | "content_then_normal_end"
  | "content_then_provider_failure"
  | "zero_content"
  | "stop_generating";

class ConfigurableMockProvider implements AIProvider {
  public readonly name = "mock-regression-provider";
  public behavior: StreamBehavior = "content_then_empty_chunk";

  async generateChatResponse(_messages: AIMessage[]): Promise<AIResponse> {
    return {
      content: "Non-streaming mock",
      provider: this.name,
      model: "mock-model",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    };
  }

  async *generateChatStream(
    _messages: AIMessage[],
    _options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    if (this.behavior === "content_then_empty_chunk") {
      yield { content: "Valid partial text 1, ", model: "mock-model" };
      yield { content: "valid partial text 2.", model: "mock-model" };
      // Empty final chunk with usage
      yield {
        content: "",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        done: true,
      };
      return;
    }

    if (this.behavior === "content_then_normal_end") {
      yield { content: "Normal ending stream text.", model: "mock-model" };
      // Stream simply ends without any final empty/done chunk
      return;
    }

    if (this.behavior === "content_then_provider_failure") {
      yield { content: "Meaningful content generated before disaster.", model: "mock-model" };
      // Simulate mid-stream provider explosion
      throw new Error("Provider stream crashed unexpectedly mid-generation");
    }

    if (this.behavior === "zero_content") {
      // Provider yields only empty content chunks and completes
      yield { content: "", model: "mock-model" };
      yield { content: "", model: "mock-model", done: true };
      return;
    }

    if (this.behavior === "stop_generating") {
      yield { content: "First chunk before user aborts.", model: "mock-model" };
      for (let i = 0; i < 50; i++) {
        if (signal?.aborted) return;
        await new Promise((r) => setTimeout(r, 20));
        yield { content: ` Chunk ${i}`, model: "mock-model" };
      }
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

const runRegressionTests = async () => {
  console.log("=== Starting Streaming Regression Test Suite ===");
  await connectDatabase();

  const mockProvider = new ConfigurableMockProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let testUserId: string | null = null;
  let conversationId: string | null = null;

  try {
    const reg = await authService.register({
      email: `stream-reg-${Date.now()}@example.com`,
      password: "Password123!",
      name: "Stream Regression User",
    });
    testUserId = reg.user.id;
    const authToken = reg.accessToken;

    await tokenService.refundCredits(testUserId, 40);

    const conv = await Conversation.create({
      userId: testUserId,
      title: "Streaming Regression Chat",
      status: "ACTIVE",
    });
    conversationId = conv._id.toString();

    // -------------------------------------------------------------
    // Test 1: content + empty final chunk = success
    // -------------------------------------------------------------
    console.log("\n[Test 1] content + empty final chunk = success");
    mockProvider.behavior = "content_then_empty_chunk";

    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 1: empty final chunk",
        stream: true,
      }),
    });

    assert.equal(res1.status, 200);
    const body1 = await res1.text();
    const events1 = parseSSEEvents(body1);

    const doneEvent1 = events1.find((e) => e.type === "done");
    assert.ok(doneEvent1, "Must emit done event");
    assert.equal(
      doneEvent1.assistantMessage.content,
      "Valid partial text 1, valid partial text 2.",
    );
    assert.equal(doneEvent1.assistantMessage.status, MESSAGE_STATUSES.COMPLETED);

    // Verify DB persistence
    const savedMsg1 = await Message.findById(doneEvent1.assistantMessage.id);
    assert.ok(savedMsg1);
    assert.equal(savedMsg1.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(savedMsg1.content, "Valid partial text 1, valid partial text 2.");
    console.log("✓ Test 1 Passed: Content followed by empty final chunk succeeds as COMPLETED");

    // -------------------------------------------------------------
    // Test 2: content + normal stream end = success
    // -------------------------------------------------------------
    console.log("\n[Test 2] content + normal stream end = success");
    mockProvider.behavior = "content_then_normal_end";

    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 2: normal stream end",
        stream: true,
      }),
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.text();
    const events2 = parseSSEEvents(body2);

    const doneEvent2 = events2.find((e) => e.type === "done");
    assert.ok(doneEvent2, "Must emit done event on normal stream completion");
    assert.equal(doneEvent2.assistantMessage.content, "Normal ending stream text.");
    assert.equal(doneEvent2.assistantMessage.status, MESSAGE_STATUSES.COMPLETED);

    const savedMsg2 = await Message.findById(doneEvent2.assistantMessage.id);
    assert.ok(savedMsg2);
    assert.equal(savedMsg2.status, MESSAGE_STATUSES.COMPLETED);
    console.log("✓ Test 2 Passed: Content followed by normal stream end succeeds as COMPLETED");

    // -------------------------------------------------------------
    // Test 3: content + provider failure = partial response preserved, genuine provider error
    // -------------------------------------------------------------
    console.log("\n[Test 3] content + provider failure = partial response handled correctly");
    mockProvider.behavior = "content_then_provider_failure";

    const balanceBefore3 = (await tokenService.getBalance(testUserId)).balance;

    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 3: mid stream failure",
        stream: true,
      }),
    });

    const body3 = await res3.text();
    const events3 = parseSSEEvents(body3);

    // Chunks were emitted before failure
    const chunkEvents3 = events3.filter((e) => e.type === "chunk");
    assert.ok(chunkEvents3.length > 0, "Should have received chunks before failure");

    // Must emit error event with genuine provider error, NOT "empty response"
    const errorEvent3 = events3.find((e) => e.type === "error");
    assert.ok(errorEvent3, "Must emit error event on provider failure");
    assert.ok(
      !errorEvent3.error.message.includes("empty response"),
      "Must NOT report empty response when content was generated!",
    );
    assert.ok(
      errorEvent3.error.message.includes("Provider stream crashed") ||
        errorEvent3.error.message.includes("AI provider"),
      "Must report actual provider failure",
    );

    // Verify partial assistant message was preserved as COMPLETED in DB
    const partialSaved = await Message.findOne({
      conversationId,
      content: "Meaningful content generated before disaster.",
    });
    assert.ok(partialSaved, "Partial assistant message must be preserved in MongoDB");
    assert.equal(partialSaved.status, MESSAGE_STATUSES.COMPLETED);

    // Credit remains consumed for partial generation
    const balanceAfter3 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter3, balanceBefore3 - 1, "Credit remains consumed for partial response");
    console.log("✓ Test 3 Passed: Provider failure after content preserves partial response and emits genuine provider error");

    // -------------------------------------------------------------
    // Test 4: zero content = genuine empty-response error
    // -------------------------------------------------------------
    console.log("\n[Test 4] zero content = genuine empty-response error");
    mockProvider.behavior = "zero_content";

    const balanceBefore4 = (await tokenService.getBalance(testUserId)).balance;

    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 4: zero content response",
        stream: true,
      }),
    });

    const body4 = await res4.text();
    const events4 = parseSSEEvents(body4);

    const errorEvent4 = events4.find((e) => e.type === "error");
    assert.ok(errorEvent4, "Must emit error event for zero content");
    assert.equal(errorEvent4.error.message, "AI provider returned an empty response");
    assert.equal(errorEvent4.error.code, "AI_PROVIDER_ERROR");

    // Credit refunded
    const balanceAfter4 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter4, balanceBefore4, "Credit must be refunded on empty response");

    // User message marked FAILED
    const userMsg4 = await Message.findOne({
      conversationId,
      content: "Test 4: zero content response",
    });
    assert.ok(userMsg4);
    assert.equal(userMsg4.status, MESSAGE_STATUSES.FAILED);
    console.log("✓ Test 4 Passed: Zero-content response returns genuine empty response error and refunds credit");

    // -------------------------------------------------------------
    // Test 5: Stop Generating = partial response preserved
    // -------------------------------------------------------------
    console.log("\n[Test 5] Stop Generating = partial response preserved");
    mockProvider.behavior = "stop_generating";

    const abortController = new AbortController();
    const balanceBefore5 = (await tokenService.getBalance(testUserId)).balance;

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 5: stop generating",
        stream: true,
      }),
      signal: abortController.signal,
    });

    const reader5 = res5.body!.getReader();
    const decoder5 = new TextDecoder();
    let accumulated5 = "";

    while (true) {
      const { done, value } = await reader5.read();
      if (done) break;
      accumulated5 += decoder5.decode(value);
      if (accumulated5.includes("First chunk")) {
        abortController.abort();
        break;
      }
    }

    // Wait briefly for server write
    await new Promise((r) => setTimeout(r, 100));

    // Verify partial assistant message was preserved
    const abortedMsgs = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    }).sort({ createdAt: -1 });

    const latestAborted = abortedMsgs[0];
    assert.ok(latestAborted, "Assistant message must exist for aborted request");
    assert.equal(latestAborted.status, MESSAGE_STATUSES.COMPLETED);
    assert.ok(latestAborted.content.includes("First chunk"));

    // Credit consumed
    const balanceAfter5 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter5, balanceBefore5 - 1, "Credit consumed for partial content");
    console.log("✓ Test 5 Passed: Stop Generating cleanly preserves partial response as COMPLETED");

    // -------------------------------------------------------------
    // Test 6: normal done event = no error
    // -------------------------------------------------------------
    console.log("\n[Test 6] normal done event = no error");
    mockProvider.behavior = "content_then_empty_chunk";

    const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Test 6: verify no error after done",
        stream: true,
      }),
    });

    const body6 = await res6.text();
    const events6 = parseSSEEvents(body6);

    const hasDone = events6.some((e) => e.type === "done");
    const hasError = events6.some((e) => e.type === "error");
    assert.ok(hasDone, "Must contain done event");
    assert.ok(!hasError, "Must NOT contain any error event after or with done event");
    console.log("✓ Test 6 Passed: Normal done event produces zero error events");

    console.log("\n=============================================================");
    console.log("=== ALL STREAMING REGRESSION TESTS PASSED (6/6) ============");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (testUserId) {
      await User.deleteOne({ _id: testUserId });
      await TokenBalance.deleteOne({ userId: testUserId });
    }
    if (conversationId) {
      await Conversation.deleteOne({ _id: conversationId });
      await Message.deleteMany({ conversationId });
    }
    await disconnectDatabase();
  }
};

runRegressionTests().catch((err) => {
  console.error("Streaming Regression Test Suite Failed:", err);
  process.exit(1);
});
