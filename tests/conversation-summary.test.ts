import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import * as summaryService from "../src/modules/conversations/conversation-summary.service.js";
import { buildFullChatContext } from "../src/modules/ai/context-builder.service.js";
import { AppError } from "../src/errors/app.error.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockSummaryAIProvider implements AIProvider {
  public readonly name = "mock-summary-ai";
  public chatCallCount = 0;
  public summaryCallCount = 0;
  public shouldFailSummary = false;
  public lastChatMessages: AIMessage[] = [];
  public lastSummaryMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-summary-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }

    const isSummarization = messages.some(
      (m) => m.role === "system" && m.content.includes("summarization system"),
    );
    if (isSummarization) {
      this.summaryCallCount++;
      this.lastSummaryMessages = JSON.parse(JSON.stringify(messages));
      if (this.shouldFailSummary) {
        throw new AppError("Simulated summarization failure", 502, "AI_PROVIDER_ERROR");
      }
      return {
        content: "- Discussed building NexaMind microservices.\n- Completed MongoDB schema and JWT authentication.\n- Left off at writing role-based access control tests.",
        provider: "mock-summary-ai",
        model: "mock-model",
        usage: { inputTokens: 40, outputTokens: 30, totalTokens: 70 },
      };
    }

    this.chatCallCount++;
    this.lastChatMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Mock Assistant response #${this.chatCallCount}`,
      provider: "mock-summary-ai",
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.chatCallCount++;
    this.lastChatMessages = JSON.parse(JSON.stringify(messages));

    yield {
      content: "Streaming response chunk",
      model: "mock-model",
    };

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Batch 4: Conversation Summaries & Continuity Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockSummaryAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `summary_user_a_${testTimestamp}@example.com`;
  const userBEmail = `summary_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let conv1Id = "";

  try {
    // 1. Setup Users
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    await tokenService.refundCredits(userAId, 50);
    await tokenService.refundCredits(userBId, 50);

    // Setup User A Conversation 1
    const conv1 = await conversationService.createConversation(userAId, {
      title: "Project Development Session",
    });
    conv1Id = conv1._id.toString();

    // -------------------------------------------------------------
    // Test 1: Summary Creation when Conversation Reaches Threshold
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing automatic summary creation upon reaching threshold...");
    // Add 6 messages (3 turns) to reach MIN_MESSAGES_FOR_SUMMARY
    for (let i = 1; i <= 3; i++) {
      await Message.create({
        conversationId: conv1Id,
        userId: userAId,
        role: MESSAGE_ROLES.USER,
        content: `User turn ${i}: Discussing architectural task ${i}`,
        status: MESSAGE_STATUSES.COMPLETED,
      });
      await Message.create({
        conversationId: conv1Id,
        userId: userAId,
        role: MESSAGE_ROLES.ASSISTANT,
        content: `Assistant turn ${i}: Solution for task ${i}`,
        status: MESSAGE_STATUSES.COMPLETED,
      });
    }

    await Conversation.findByIdAndUpdate(conv1Id, { messageCount: 6, lastMessageAt: new Date() });

    // Assert shouldSummarizeConversation is true
    assert.equal(summaryService.shouldSummarizeConversation(6, 0), true);

    const summaryResult = await summaryService.summarizeConversation(conv1Id, userAId, mockProvider);
    assert.ok(summaryResult, "Summary must be successfully produced");
    assert.ok(summaryResult.includes("NexaMind microservices"), "Summary must contain key topics");
    assert.ok(summaryResult.includes("Left off at"), "Summary must contain where things left off");

    const savedConv1 = await Conversation.findById(conv1Id);
    assert.equal(savedConv1?.summary, summaryResult);
    assert.ok(savedConv1?.summaryUpdatedAt instanceof Date);
    assert.equal(savedConv1?.lastSummarizedMessageCount, 6);
    console.log("✓ Test 1 Passed: Summary generated and saved atomically in MongoDB at message threshold");

    // -------------------------------------------------------------
    // Test 2: Summary Update / Incremental Regeneration
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing summary regeneration upon reaching next interval...");
    // Add 6 more messages (total 12)
    for (let i = 4; i <= 6; i++) {
      await Message.create({
        conversationId: conv1Id,
        userId: userAId,
        role: MESSAGE_ROLES.USER,
        content: `User turn ${i}: Refactoring tests for module ${i}`,
        status: MESSAGE_STATUSES.COMPLETED,
      });
      await Message.create({
        conversationId: conv1Id,
        userId: userAId,
        role: MESSAGE_ROLES.ASSISTANT,
        content: `Assistant turn ${i}: Implemented tests for module ${i}`,
        status: MESSAGE_STATUSES.COMPLETED,
      });
    }
    await Conversation.findByIdAndUpdate(conv1Id, { messageCount: 12, lastMessageAt: new Date() });

    assert.equal(summaryService.shouldSummarizeConversation(12, 6), true);

    // Call summarizeConversation again
    const updatedSummary = await summaryService.summarizeConversation(conv1Id, userAId, mockProvider);
    assert.ok(updatedSummary);

    const savedConv1Updated = await Conversation.findById(conv1Id);
    assert.equal(savedConv1Updated?.lastSummarizedMessageCount, 12);
    assert.ok(savedConv1Updated?.summaryUpdatedAt);

    // Verify prompt included previous summary for incremental update
    const summaryPromptMessages = mockProvider.lastSummaryMessages;
    assert.ok(
      summaryPromptMessages.some((m) => m.content.includes("Previous conversation summary:")),
      "Summarization prompt must include previous summary for incremental context",
    );
    console.log("✓ Test 2 Passed: Incremental summary updated atomically with previous context");

    // -------------------------------------------------------------
    // Test 3: Summary Retrieval Endpoints
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing summary retrieval endpoints...");
    const getSummaryRes = await fetch(`${baseUrl}/api/v1/conversations/${conv1Id}/summary`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getSummaryRes.status, 200);
    const summaryJson = (await getSummaryRes.json()) as any;
    assert.equal(summaryJson.success, true);
    assert.equal(summaryJson.data.conversationId, conv1Id);
    assert.ok(summaryJson.data.summary.includes("NexaMind"));
    assert.equal(summaryJson.data.lastSummarizedMessageCount, 12);

    const getConvRes = await fetch(`${baseUrl}/api/v1/conversations/${conv1Id}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getConvRes.status, 200);
    const convJson = (await getConvRes.json()) as any;
    assert.equal(convJson.data.summary, summaryJson.data.summary);
    console.log("✓ Test 3 Passed: Summary retrieved via GET /conversations/:id/summary and GET /conversations/:id");

    // -------------------------------------------------------------
    // Test 4: Long Conversation Context Reduction
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing long conversation context reduction via summary...");
    // With summary: buildFullChatContext fetches only recent messages window (6) instead of all 12
    const contextWithSummary = await buildFullChatContext({
      userId: userAId,
      conversationId: conv1Id,
      userQuery: "What is next?",
      maxMessages: 20,
    });

    // Verify that contextWithSummary has:
    // - Conversation summary included in latest message
    const latestMsg = contextWithSummary[contextWithSummary.length - 1]!;
    assert.ok(
      latestMsg.content.includes("Conversation summary:"),
      "Context must include Conversation summary block",
    );
    assert.ok(
      latestMsg.content.includes("Left off at writing role-based access control tests"),
      "Context must include summary content",
    );

    // Number of history messages should be capped to recent messages window (<= 6) rather than all 12
    assert.ok(
      contextWithSummary.length <= 7, // 6 recent history + 1 latest message
      `Context message count (${contextWithSummary.length}) must be reduced compared to total 12 messages`,
    );

    // Verify older turn 1 is NOT present in raw history (since it was summarized)
    const hasTurn1Raw = contextWithSummary.some(
      (m) => m.content.includes("User turn 1: Discussing architectural task 1"),
    );
    assert.equal(hasTurn1Raw, false, "Older messages covered by summary must be omitted from raw history");
    console.log("✓ Test 4 Passed: Context builder pruned older raw messages, replacing them with the summary");

    // -------------------------------------------------------------
    // Test 5: 'Where did we leave off?' Answered from Persisted Summary
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing natural query 'Where did we leave off?' receives persisted summary...");
    const chatRes5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "Where did we leave off?",
      }),
    });

    assert.equal(chatRes5.status, 200);
    const sentMsg5 = mockProvider.lastChatMessages[mockProvider.lastChatMessages.length - 1]!;
    assert.ok(
      sentMsg5.content.includes("Conversation summary:"),
      "Provider prompt must include Conversation summary",
    );
    assert.ok(
      sentMsg5.content.includes("Left off at writing role-based access control tests"),
      "Provider prompt must include 'left off' content from summary",
    );
    assert.ok(
      sentMsg5.content.includes("Where did we leave off?"),
      "Provider prompt must include the user's natural query",
    );
    console.log("✓ Test 5 Passed: Natural query 'Where did we leave off?' receives persisted summary in LLM context");

    // -------------------------------------------------------------
    // Test 6: Summary Ownership & User Isolation
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing cross-user isolation for summaries...");
    // User B tries to get User A's summary
    const userBAccessRes = await fetch(`${baseUrl}/api/v1/conversations/${conv1Id}/summary`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(userBAccessRes.status, 404, "User B must not access User A's summary");

    // User B cannot trigger summarization on User A's conversation
    const unauthorizedSummary = await summaryService.summarizeConversation(conv1Id, userBId, mockProvider);
    assert.equal(unauthorizedSummary, null, "User B cannot summarize User A's conversation");
    console.log("✓ Test 6 Passed: Strict cross-user isolation verified for conversation summaries");

    // -------------------------------------------------------------
    // Test 7: Provider Failure Handling (Fail-Safe)
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing provider failure handling preserves existing summary...");
    mockProvider.shouldFailSummary = true;
    const failedSummaryResult = await summaryService.summarizeConversation(conv1Id, userAId, mockProvider);
    assert.equal(failedSummaryResult, null, "Summarization returns null on provider failure");

    // Existing summary must remain intact
    const intactConv = await Conversation.findById(conv1Id);
    assert.ok(intactConv?.summary, "Existing summary must not be deleted on provider failure");
    assert.equal(intactConv?.summary, savedConv1Updated?.summary);

    // Chat must continue to work normally despite summary provider glitch
    mockProvider.shouldFailSummary = false;
    const chatRes7 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "Hello again after summary glitch",
      }),
    });
    assert.equal(chatRes7.status, 200, "Chat proceeds normally despite previous summarization failure");
    console.log("✓ Test 7 Passed: Provider failure safely handled without corrupting conversation");

    // -------------------------------------------------------------
    // Test 8: Duplicate-Summary Prevention / In-Flight Deduping
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing in-flight duplicate summarization prevention...");
    // Trigger two concurrent summarizations on the same conversation
    const [run1, run2] = await Promise.all([
      summaryService.summarizeConversation(conv1Id, userAId, mockProvider),
      summaryService.summarizeConversation(conv1Id, userAId, mockProvider),
    ]);
    // Exactly one must execute and return string; the other returns null due to in-flight set
    const executedCount = [run1, run2].filter((r) => r !== null).length;
    assert.equal(executedCount, 1, "Exactly one concurrent summarization should execute");
    console.log("✓ Test 8 Passed: In-flight deduplication prevented concurrent duplicate summarization");

    // -------------------------------------------------------------
    // Test 9: Context Window Limits & Budgeting
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing character budget bounds with summary and memories...");
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "Prefers concise technical answers in TypeScript",
      status: MEMORY_STATUSES.ACTIVE,
    });

    const smallBudget = 300;
    const budgetedContext = await buildFullChatContext({
      userId: userAId,
      conversationId: conv1Id,
      userQuery: "Continue working on authentication",
      maxChars: smallBudget,
      maxMessages: 20,
    });

    const totalChars = budgetedContext.reduce((acc, m) => acc + m.content.length, 0);
    assert.ok(
      totalChars <= smallBudget,
      `Total context chars (${totalChars}) must not exceed maxChars (${smallBudget})`,
    );
    console.log("✓ Test 9 Passed: Context budgeting strictly respected with summary, memory, and dialog");

    // -------------------------------------------------------------
    // Test 10: Streaming Chat Regression with Summary
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing streaming chat receives conversation summary...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "Stream our next steps based on where we left off",
        stream: true,
      }),
    });

    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));
    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes("Streaming response chunk"));

    const streamCaptured = mockProvider.lastChatMessages[mockProvider.lastChatMessages.length - 1]!;
    assert.ok(
      streamCaptured.content.includes("Conversation summary:"),
      "Streaming chat prompt must contain Conversation summary",
    );
    assert.ok(
      streamCaptured.content.includes("Stream our next steps"),
      "Streaming chat prompt must contain user query",
    );
    console.log("✓ Test 10 Passed: Streaming chat seamlessly receives conversation summary");

    console.log("\n=============================================================");
    console.log("=== ALL CONVERSATION SUMMARY TESTS PASSED (10/10) ===========");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const users = await User.find({ email: { $in: [userAEmail, userBEmail] } });
      const ids = users.map((u) => u._id);
      if (ids.length > 0) {
        await Conversation.deleteMany({ userId: { $in: ids } });
        await Message.deleteMany({ userId: { $in: ids } });
        await Memory.deleteMany({ userId: { $in: ids } });
        await User.deleteMany({ _id: { $in: ids } });
      }
    } catch {}
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Conversation Summary Test Suite Failed:", err);
  process.exit(1);
});
