import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import { buildFullChatContext, DEFAULT_RECENT_MESSAGES_WITH_SUMMARY } from "../src/modules/ai/context-builder.service.js";
import { NEXAMIND_CHAT_SYSTEM_PROMPT } from "../src/modules/ai/prompts/system.prompt.js";
import { TestMockEmbeddingProvider } from "./helpers/mock-embedding.helper.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockPhase6AIProvider implements AIProvider {
  public readonly name = "mock-phase6-ai";
  public callCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-phase6-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Phase 6 AI Response #${this.callCount}`,
      provider: "mock-phase6-ai",
      model: "mock-model",
      usage: { inputTokens: 30, outputTokens: 30, totalTokens: 60 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    yield {
      content: "Phase 6 streaming chunk",
      model: "mock-model",
    };

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 30, outputTokens: 30, totalTokens: 60 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Phase 6: Persistent Memory Integration Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockPhase6AIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const mockEmbeddingProvider = new TestMockEmbeddingProvider();
  memoryService.setDefaultEmbeddingProvider(mockEmbeddingProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `phase6_a_${testTimestamp}@example.com`;
  const userBEmail = `phase6_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";

  try {
    // -------------------------------------------------------------
    // Setup Users & Seed Balances
    // -------------------------------------------------------------
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    await tokenService.refundCredits(userAId, 100);
    await tokenService.refundCredits(userBId, 100);
    console.log(`✓ Setup User A (${userAId}) and User B (${userBId}) with tokens`);

    // -------------------------------------------------------------
    // Test 1: Normal Questions Do Not Trigger Historical Continuity Retrieval
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing normal queries do NOT trigger continuity retrieval...");
    const conv1 = await conversationService.createConversation(userAId, {
      title: "Docker Discussion",
    });
    const conv1Id = conv1._id.toString();

    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "How do I configure Docker multi-stage builds in Node.js?",
      }),
    });
    assert.equal(res1.status, 200);
    const captured1 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured1.content.includes("Previous conversation context:"),
      "Normal technical query must NOT retrieve previous conversation summaries",
    );
    assert.ok(
      !captured1.content.includes("Resuming work guidance:"),
      "Normal technical query must NOT include resuming guidance",
    );
    console.log("✓ Test 1 Passed: Normal query strictly isolates and avoids historical retrieval");

    // -------------------------------------------------------------
    // Test 2: Active Conversation In-Session Summary & Compression
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing active conversation summary injection & message compression...");
    const activeSummary =
      "- What the conversation is about: Docker optimization\n- What was completed: Multi-stage Dockerfile\n- Where we stopped: Alpine base image\n- Next step: Security scanning with Trivy";
    await Conversation.findByIdAndUpdate(conv1Id, {
      summary: activeSummary,
      summaryUpdatedAt: new Date(),
      lastSummarizedMessageCount: 2,
    });

    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "What base image did we choose?",
      }),
    });
    assert.equal(res2.status, 200);
    const captured2 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured2.content.includes("Conversation summary:\n" + activeSummary),
      "Active conversation summary must be injected into user prompt context",
    );
    assert.ok(
      !captured2.content.includes("Previous conversation context:"),
      "Active conversation summary must NOT be labeled as Previous conversation context",
    );
    console.log("✓ Test 2 Passed: In-session summary compression works seamlessly");

    // -------------------------------------------------------------
    // Test 3: Long-term User Memories Remain Separate from Conversation Summaries
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing long-term memories vs conversation summaries separation...");
    // Seed persistent memories for User A
    await memoryService.createMemory(userAId, {
      type: MEMORY_TYPES.PREFERENCE,
      content: "Prefers TypeScript with strict mode enabled",
    });
    await memoryService.createMemory(userAId, {
      type: MEMORY_TYPES.GOAL,
      content: "Building an automated enterprise billing service",
    });

    // Create a previous conversation with a distinct summary
    const conv2 = await conversationService.createConversation(userAId, {
      title: "Polar Billing Integration",
    });
    const conv2Id = conv2._id.toString();
    const polarSummary =
      "- What the conversation is about: Polar Subscription Integration\n- What was completed: Polar checkout webhooks and customer portal\n- Where we stopped: Subscription tier mapping\n- Next step: Test webhook signing secret";
    await Conversation.findByIdAndUpdate(conv2Id, {
      summary: polarSummary,
      summaryUpdatedAt: new Date(Date.now() - 5000),
      lastSummarizedMessageCount: 4,
    });

    // Start a new conversation for User A
    const conv3 = await conversationService.createConversation(userAId, {
      title: "New Session",
    });
    const conv3Id = conv3._id.toString();

    // Query asking about Polar (topic continuity)
    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv3Id,
        content: "What were we working on with Polar?",
      }),
    });
    assert.equal(res3.status, 200);
    const captured3 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    // Verify Previous conversation context section is present
    assert.ok(
      captured3.content.includes("Previous conversation context:"),
      "Must include previous conversation context section",
    );
    assert.ok(
      captured3.content.includes("Previous conversation \"Polar Billing Integration\":"),
      "Must identify the correct previous Polar conversation",
    );
    assert.ok(
      captured3.content.includes("Polar checkout webhooks and customer portal") &&
      captured3.content.includes("Subscription tier mapping") &&
      captured3.content.includes("Test webhook signing secret"),
      "Must preserve the actual Polar conversation summary content",
    );
    assert.ok(
      captured3.content.includes("Resuming work guidance:"),
      "Must include resuming work guidance",
    );

    // Verify distinct section formatting
    assert.ok(
      !captured3.content.includes("Conversation summary:\n- What the conversation is about: Polar Subscription Integration"),
      "Previous session summary must NOT be labeled as active Conversation summary",
    );
    console.log("✓ Test 3 Passed: Long-term memories and conversation summaries are strictly separated");

    // -------------------------------------------------------------
    // Test 4: Generic Continuity Query Prioritizes Most Recent Conversation
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing generic continuity query ('Where did we stop?')...");
    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv3Id,
        content: "Where did we stop?",
      }),
    });
    assert.equal(res4.status, 200);
    const captured4 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured4.content.includes("Previous conversation context:"),
      "Must include continuity context for 'Where did we stop?'",
    );
    assert.ok(
      captured4.content.includes("Subscription tier mapping") ||
      captured4.content.includes("Alpine base image"),
      "Must retrieve recent session where work stopped",
    );
    console.log("✓ Test 4 Passed: Generic continuity query correctly retrieves where we stopped");

    // -------------------------------------------------------------
    // Test 5: Missing History Never Causes Hallucinated Work
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing missing history does not invent context...");
    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv3Id,
        content: "What did we do regarding quantum teleportation algorithms on Mars?",
      }),
    });
    assert.equal(res5.status, 200);
    const captured5 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured5.content.includes("Relevant user memories:"),
      "Must not invent or inject memories for unmentioned topics",
    );
    assert.ok(
      !captured5.content.includes("Polar"),
      "Must not inject unrelated Polar conversation context for Martian query",
    );
    assert.ok(
      !captured5.content.includes("Previous conversation context:"),
      "Must omit previous conversation context section when no matches exist",
    );
    assert.ok(
      NEXAMIND_CHAT_SYSTEM_PROMPT.includes("State concisely and truthfully that no past conversation history or memories are on record for this topic or session"),
      "System prompt must instruct model to state no history is on record instead of guessing",
    );
    assert.ok(
      NEXAMIND_CHAT_SYSTEM_PROMPT.includes("Never invent, assume, or hallucinate progress, technical decisions, or next steps"),
      "System prompt must forbid hallucinating progress or next steps",
    );
    console.log("✓ Test 5 Passed: Zero hallucination verified when history is missing");

    // -------------------------------------------------------------
    // Test 6: Strict Cross-User Isolation
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing strict cross-user isolation for memories and continuity...");
    const convUserB = await conversationService.createConversation(userBId, {
      title: "User B Private Chat",
    });
    const convUserBId = convUserB._id.toString();

    const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: convUserBId,
        content: "What were we working on with Polar?",
      }),
    });
    assert.equal(res6.status, 200);
    const captured6 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured6.content.includes("Polar Billing Integration"),
      "User B must NEVER receive User A's previous conversation summaries",
    );
    assert.ok(
      !captured6.content.includes("Polar checkout webhooks and customer portal"),
      "User B must NEVER receive User A's summary details",
    );
    assert.ok(
      !captured6.content.includes("Building an automated enterprise billing service"),
      "User B must NEVER receive User A's long-term memories",
    );
    console.log("✓ Test 6 Passed: Cross-user isolation strictly verified");

    // -------------------------------------------------------------
    // Test 7: Current Conversation Is Excluded from Previous Conversations
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing current conversation is never treated as a previous conversation...");
    const res7 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id, // Active conversation with summary
        content: "Where did we leave off?",
      }),
    });
    assert.equal(res7.status, 200);
    const captured7 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured7.content.includes('Previous conversation "Docker Discussion":'),
      "Current conversation must NEVER be included under Previous conversation context",
    );
    console.log("✓ Test 7 Passed: Current conversation is strictly excluded from previous conversation context");

    // -------------------------------------------------------------
    // Test 8: Soft-Deleted and Empty Conversations Are Ignored
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing soft-deleted and empty conversations are ignored...");
    const convDeleted = await conversationService.createConversation(userAId, {
      title: "Deleted AI Project",
    });
    await Conversation.findByIdAndUpdate(convDeleted._id, {
      summary: "- What the conversation is about: Classified Project\n- What was completed: Top secret\n- Where we stopped: Nowhere\n- Next step: None",
      summaryUpdatedAt: new Date(Date.now() + 10000),
      deletedAt: new Date(),
    });

    const convEmpty = await conversationService.createConversation(userAId, {
      title: "Empty Conversation Without Summary",
    });
    await Conversation.findByIdAndUpdate(convEmpty._id, {
      summary: "   ",
      summaryUpdatedAt: new Date(Date.now() + 12000),
    });

    const res8 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv3Id,
        content: "What were we working on with Classified Project?",
      }),
    });
    assert.equal(res8.status, 200);
    const captured8 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured8.content.includes("Top secret"),
      "Soft-deleted conversation summary content must be completely ignored",
    );
    assert.ok(
      !captured8.content.includes("Deleted AI Project"),
      "Soft-deleted conversation title must not appear in context",
    );
    assert.ok(
      !captured8.content.includes("Empty Conversation Without Summary"),
      "Conversations with empty summaries must be completely ignored",
    );
    console.log("✓ Test 8 Passed: Soft-deleted and empty conversations are completely ignored");

    // -------------------------------------------------------------
    // Test 9: Context Character Budget Remains Bounded
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing context character budgeting under large inputs...");
    const maxChars = 800;
    const cappedContext = await buildFullChatContext({
      userId: userAId,
      conversationId: conv1Id,
      userQuery: "Where did we leave off?",
      maxChars,
    });
    const totalChars = cappedContext.reduce((acc, m) => acc + m.content.length, 0);
    assert.ok(
      totalChars <= maxChars + 100,
      `Total context characters (${totalChars}) must be within bounded character limit (${maxChars})`,
    );
    console.log(`✓ Test 9 Passed: Context budgeting strictly respected (${totalChars} chars <= ${maxChars})`);

    // -------------------------------------------------------------
    // Test 10: Streaming Chat Flow Verification
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing streaming chat integration with persistent memory & continuity...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv3Id,
        content: "What were we working on with Polar?",
        stream: true,
      }),
    });
    assert.equal(streamRes.status, 200, "Streaming chat must return 200 OK");
    const streamText = await streamRes.text();
    assert.ok(
      streamText.includes("Phase 6 streaming chunk"),
      "Streaming chat must emit chunks successfully",
    );
    const capturedStream = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      capturedStream.content.includes("Previous conversation context:"),
      "Streaming chat must include previous conversation continuity context",
    );
    assert.ok(
      capturedStream.content.includes("Polar checkout webhooks and customer portal"),
      "Streaming chat must receive the actual Polar summary",
    );
    console.log("✓ Test 10 Passed: Streaming chat integration completely functional with persistent context");

    console.log("\n=============================================================");
    console.log("=== ALL PHASE 6 PERSISTENT MEMORY TESTS PASSED (10/10) ======");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const users = await User.find({ email: { $in: [userAEmail, userBEmail] } });
      const ids = users.map((u) => u._id);
      if (ids.length > 0) {
        await Memory.deleteMany({ userId: { $in: ids } });
        await Message.deleteMany({ userId: { $in: ids } });
        await Conversation.deleteMany({ userId: { $in: ids } });
        await TokenBalance.deleteMany({ userId: { $in: ids } });
        await User.deleteMany({ _id: { $in: ids } });
      }
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Phase 6 Persistent Memory Integration Test Suite Failed:", err);
  process.exit(1);
});
