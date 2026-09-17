import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
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

class MockStreamingAIProvider implements AIProvider {
  public readonly name = "mock-stream";
  public callCount = 0;
  public failBeforeStream = false;
  public failDuringStream = false;
  public delayMs = 15;
  public chunks = ["Chunk 1: Hello, ", "Chunk 2: this is ", "Chunk 3: streaming!"];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.callCount++;
    return {
      content: this.chunks.join(""),
      provider: "mock-stream",
      model: "mock-stream-model",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
  }

  async *generateChatStream(
    _messages: AIMessage[],
    _options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.callCount++;
    if (this.failBeforeStream) {
      throw new Error("Simulated immediate upstream provider failure");
    }

    for (let i = 0; i < this.chunks.length; i++) {
      if (signal?.aborted) return;
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (signal?.aborted) return;
      if (this.failDuringStream && i === 1) {
        throw new Error("Simulated mid-stream provider error");
      }
      yield {
        content: this.chunks[i]!,
        model: "mock-stream-model",
      };
    }

    yield {
      content: "",
      model: "mock-stream-model",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Streaming AI Chat & Cancellation Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockStreamingAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  let testUserId = "";
  let authToken = "";
  let conversationId = "";

  try {
    // Setup test user and conversation
    const unique = Date.now().toString(36);
    const reg = await authService.register({
      email: `streamtest_${unique}@test.com`,
      password: "Password123!",
    });
    testUserId = reg.user.id;
    authToken = reg.accessToken;

    const conv = await Conversation.create({
      userId: testUserId,
      title: "Streaming Test Conversation",
      status: CONVERSATION_STATUSES.ACTIVE,
    });
    conversationId = conv._id.toString();

    // Give user 10 credits
    await tokenService.refundCredits(testUserId, 10);
    const initialBalance = (await tokenService.getBalance(testUserId)).balance;
    assert.ok(initialBalance >= 10, "User must have at least 10 credits");

    // -------------------------------------------------------------
    // Test 1: Progressive SSE Chunks & Final Message Persistence
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing successful SSE stream and persistence...");
    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Please stream this test response",
        stream: true,
      }),
    });

    assert.equal(res1.status, 200, "Streaming endpoint must return 200 OK");
    assert.ok(
      res1.headers.get("content-type")?.includes("text/event-stream"),
      "Response must have text/event-stream content-type",
    );

    const bodyText1 = await res1.text();
    const lines1 = bodyText1.split("\n\n").map((l) => l.trim()).filter(Boolean);

    // Parse events
    const events: any[] = [];
    for (const line of lines1) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.slice(6)));
      }
    }

    assert.ok(events.length >= 4, "Must receive start, chunks, and done events");
    assert.equal(events[0]?.type, "start", "First event must be start");
    assert.ok(events[0]?.userMessage?.id, "Start event must contain user message ID");

    const chunkEvents = events.filter((e) => e.type === "chunk");
    assert.equal(chunkEvents.length, 3, "Must receive exactly 3 chunk events");
    const fullStreamedContent = chunkEvents.map((c) => c.content).join("");
    assert.equal(fullStreamedContent, mockProvider.chunks.join(""));

    const doneEvent = events.find((e) => e.type === "done");
    assert.ok(doneEvent, "Must receive done event");
    assert.equal(doneEvent.assistantMessage.role, MESSAGE_ROLES.ASSISTANT);
    assert.equal(doneEvent.assistantMessage.content, fullStreamedContent);

    // Verify persistence in MongoDB
    const persistedAssistant = await Message.findById(doneEvent.assistantMessage.id);
    assert.ok(persistedAssistant, "Assistant message must be persisted in database");
    assert.equal(persistedAssistant.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(persistedAssistant.content, fullStreamedContent);

    // Verify credit was deducted exactly by 1
    const balanceAfter1 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter1, initialBalance - 1, "Exactly 1 credit must be deducted");
    console.log("✓ Test 1 Passed: Progressive SSE chunks, MongoDB persistence, and 1 credit deducted");

    // -------------------------------------------------------------
    // Test 2: Stop Generating / Client Abort with Partial Content
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing Stop Generating mid-stream preserves partial content...");
    const abortController = new AbortController();
    mockProvider.delayMs = 40; // longer delay to allow aborting after first chunk

    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Stop this mid-stream",
        stream: true,
      }),
      signal: abortController.signal,
    });

    assert.equal(res2.status, 200);
    const reader2 = res2.body!.getReader();
    const decoder2 = new TextDecoder();
    let partialReceived = "";

    // Read first chunk, then abort
    while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      const text = decoder2.decode(value);
      partialReceived += text;
      if (partialReceived.includes("Chunk 1")) {
        // Abort now!
        abortController.abort();
        break;
      }
    }

    // Wait briefly for server-side close event and database write
    await new Promise((r) => setTimeout(r, 100));

    // Verify partial assistant message was persisted and credit consumed
    const partialMessages = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    }).sort({ createdAt: -1 });

    const latestAssistant = partialMessages[0];
    assert.ok(latestAssistant, "Assistant message must exist for partial stop");
    assert.equal(latestAssistant.status, MESSAGE_STATUSES.COMPLETED);
    assert.ok(latestAssistant.content.includes("Chunk 1"), "Partial content must be saved");

    const balanceAfter2 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter2, balanceAfter1 - 1, "Credit remains consumed for partial generation");
    console.log("✓ Test 2 Passed: Partial response cleanly preserved as COMPLETED, credit consumed");

    // -------------------------------------------------------------
    // Test 3: Provider Failure Before Stream -> Credit Refunded & User Msg FAILED
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing provider failure before stream triggers credit refund...");
    mockProvider.failBeforeStream = true;
    mockProvider.delayMs = 10;

    const balanceBefore3 = (await tokenService.getBalance(testUserId)).balance;

    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Trigger provider failure",
        stream: true,
      }),
    });

    const bodyText3 = await res3.text();
    // Because failure happened in processChatStream before chunks, res.headersSent might be false or true
    if (res3.status === 200) {
      assert.ok(bodyText3.includes('"type":"error"'));
    } else {
      assert.equal(res3.status, 502);
    }

    const balanceAfter3 = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(balanceAfter3, balanceBefore3, "Credit must be refunded on provider failure");

    const failedUserMsg = await Message.findOne({
      conversationId,
      content: "Trigger provider failure",
    });
    assert.ok(failedUserMsg, "User message must be found");
    assert.equal(failedUserMsg.status, MESSAGE_STATUSES.FAILED, "User message must be marked FAILED");
    console.log("✓ Test 3 Passed: Upstream failure refunded credit and marked user message FAILED");

    // -------------------------------------------------------------
    // Test 4: Insufficient Credits Rejection (402)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing zero credits rejection returns 402...");
    mockProvider.failBeforeStream = false;
    const currentBalance = (await tokenService.getBalance(testUserId)).balance;
    await tokenService.deductCredits(testUserId, currentBalance);

    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Will I stream with 0 credits?",
        stream: true,
      }),
    });

    assert.equal(res4.status, 402, "Zero balance must be rejected with 402 INSUFFICIENT_CREDITS");
    const json4 = await res4.json();
    assert.equal(json4.error.code, "INSUFFICIENT_CREDITS");
    console.log("✓ Test 4 Passed: 402 INSUFFICIENT_CREDITS returned without starting stream");

    // -------------------------------------------------------------
    // Test 5: Existing Non-Streaming /api/v1/ai/chat Regression
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing non-streaming /api/v1/ai/chat endpoint works unchanged...");
    await tokenService.refundCredits(testUserId, 5);

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Non-streaming regression check",
      }),
    });

    assert.equal(res5.status, 200, "Non-streaming endpoint must return 200 OK");
    const json5 = await res5.json();
    assert.equal(json5.success, true);
    assert.equal(json5.data.assistantMessage.content, mockProvider.chunks.join(""));
    console.log("✓ Test 5 Passed: Existing non-streaming /api/v1/ai/chat works completely unchanged");

    console.log("\n=============================================================");
    console.log("=== ALL STREAMING CHAT & CANCELLATION TESTS PASSED (5/5) ====");
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

runTests().catch((err) => {
  console.error("Streaming Chat Test Suite Failed:", err);
  process.exit(1);
});
