import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import * as memoryRepository from "../src/modules/memory/memory.repository.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MemoryContextMockProvider implements AIProvider {
  public readonly name = "mock-memory-provider";
  public callCount = 0;
  public shouldFail = false;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-memory-provider",
        model: "mock-memory-model",
        usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    if (this.shouldFail) {
      throw new Error("Simulated upstream provider failure");
    }

    return {
      content: `Mock AI response #${this.callCount}`,
      provider: "mock-memory-provider",
      model: "mock-memory-model",
      usage: {
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40,
      },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting M3: Memory Retrieval & AI Context Integration Test Suite ===");
  await connectDatabase();

  const mockProvider = new MemoryContextMockProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `mem_ctx_a_${testTimestamp}@example.com`;
  const userBEmail = `mem_ctx_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let convAId = "";
  let convBId = "";

  try {
    // -------------------------------------------------------------
    // Setup Users & Conversations
    // -------------------------------------------------------------
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    const convA = await conversationService.createConversation(userAId, {
      title: "Memory Context Conversation A",
    });
    convAId = convA._id.toString();

    const convB = await conversationService.createConversation(userBId, {
      title: "Memory Context Conversation B",
    });
    convBId = convB._id.toString();

    console.log(`✓ Setup User A (${userAId}) and User B (${userBId})`);

    // -------------------------------------------------------------
    // Test 1: User with active memories receives formatted memory context
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing user with active memories receives formatted context...");
    const mem1 = await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "User prefers dark mode and TypeScript",
      status: MEMORY_STATUSES.ACTIVE,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
    });

    const mem2 = await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.PREFERENCE,
      content: "Prefers concise technical answers",
      status: MEMORY_STATUSES.ACTIVE,
      createdAt: new Date("2026-01-01T10:05:00.000Z"),
    });

    const chatRes1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "What are your recommendations for my IDE?",
      }),
    });

    assert.equal(chatRes1.status, 200, "Chat request must return 200 OK");
    assert.equal(mockProvider.capturedMessages.length, 1);
    const sentMsg = mockProvider.capturedMessages[0]!;
    assert.equal(sentMsg.role, "user");
    assert.ok(
      sentMsg.content.startsWith("Relevant user memories:\n"),
      "Context must start with 'Relevant user memories:' header",
    );
    assert.ok(
      sentMsg.content.includes("- [PREFERENCE] Prefers concise technical answers"),
      "Context must include preference memory",
    );
    assert.ok(
      sentMsg.content.includes("- [FACT] User prefers dark mode and TypeScript"),
      "Context must include fact memory",
    );
    assert.ok(
      sentMsg.content.endsWith("What are your recommendations for my IDE?"),
      "Context must end with original user query",
    );
    console.log("✓ User active memories correctly formatted and injected into user prompt context");

    // -------------------------------------------------------------
    // Test 2: Deleted memories are NEVER included in AI context
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing deleted memories are never included in context...");
    const deletedMem = await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "DELETED SECRET: User used to live in Antarctica",
      status: MEMORY_STATUSES.DELETED,
      deletedAt: new Date(),
      createdAt: new Date("2026-01-01T10:10:00.000Z"),
    });

    await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "Where did I used to live?",
      }),
    });

    const latestTurn = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !latestTurn.content.includes("Antarctica"),
      "Soft-deleted memory content must never be sent to the AI provider",
    );
    console.log("✓ Soft-deleted memories strictly excluded from AI context");

    // -------------------------------------------------------------
    // Test 3: User A's memories NEVER appear for User B (User Scoping / IDOR Protection)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing cross-user memory isolation...");
    // User B sends chat request
    const chatResB = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "Do you know my preferences?",
      }),
    });

    assert.equal(chatResB.status, 200);
    const userBMsg = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !userBMsg.content.includes("TypeScript"),
      "User A memories must never leak to User B",
    );
    assert.ok(
      !userBMsg.content.includes("dark mode"),
      "User A memories must never leak to User B",
    );
    assert.ok(
      !userBMsg.content.includes("Relevant user memories:"),
      "User B has no memories so no memory block should be injected",
    );
    assert.equal(
      userBMsg.content,
      "Do you know my preferences?",
      "User B message should contain only their own prompt",
    );
    console.log("✓ Cross-user memory isolation verified (zero leakage between users)");

    // -------------------------------------------------------------
    // Test 4: Memory IDs and metadata are NOT exposed to the provider
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing internal MongoDB IDs are not exposed to provider...");
    const mem1IdStr = mem1._id.toString();
    const mem2IdStr = mem2._id.toString();
    const delMemIdStr = deletedMem._id.toString();

    assert.ok(
      !sentMsg.content.includes(mem1IdStr),
      "Memory 1 ObjectId must not appear in provider context",
    );
    assert.ok(
      !sentMsg.content.includes(mem2IdStr),
      "Memory 2 ObjectId must not appear in provider context",
    );
    assert.ok(
      !sentMsg.content.includes(delMemIdStr),
      "Deleted Memory ObjectId must not appear in provider context",
    );
    assert.ok(
      !sentMsg.content.includes(userAId),
      "User ObjectId must not appear in provider context",
    );
    console.log("✓ Internal ObjectIds and metadata completely excluded from AI context");

    // -------------------------------------------------------------
    // Test 5: Deterministic formatting of memory context
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing deterministic formatting of memory context...");
    const contextStr1 = await memoryService.getActiveMemoryContextForUser(userAId, 10);
    const contextStr2 = await memoryService.getActiveMemoryContextForUser(userAId, 10);
    assert.equal(contextStr1, contextStr2, "Context formatting must be 100% deterministic");
    assert.equal(
      contextStr1,
      "Relevant user memories:\n- [PREFERENCE] Prefers concise technical answers\n- [FACT] User prefers dark mode and TypeScript",
    );
    console.log("✓ Deterministic formatting verified across multiple invocations");

    // -------------------------------------------------------------
    // Test 6 & 8: Server-side maximum bounds memory retrieval (newest prioritized)
    // -------------------------------------------------------------
    console.log("\n[Test 6 & 8] Testing server-side bounding and newest memory prioritization...");
    // Clear User A memories and seed 15 active memories with distinct timestamps
    await Memory.deleteMany({ userId: userAId });
    for (let i = 1; i <= 15; i++) {
      await Memory.create({
        userId: userAId,
        type: MEMORY_TYPES.FACT,
        content: `Memory item number ${String(i).padStart(2, "0")}`,
        status: MEMORY_STATUSES.ACTIVE,
        createdAt: new Date(Date.now() - (20 - i) * 60000), // Item 15 is newest, item 01 is oldest
      });
    }

    // Default limit is env.AI_MAX_MEMORY_CONTEXT (10)
    const boundedContext = await memoryService.getActiveMemoryContextForUser(
      userAId,
      env.AI_MAX_MEMORY_CONTEXT,
    );
    assert.ok(boundedContext !== null);
    const lines = boundedContext.split("\n").filter((l) => l.startsWith("- [FACT]"));
    assert.equal(
      lines.length,
      env.AI_MAX_MEMORY_CONTEXT,
      `Should retrieve exactly ${env.AI_MAX_MEMORY_CONTEXT} memories`,
    );
    // Item 15 (newest) must be first; items 01..05 (oldest) must be excluded
    assert.ok(lines[0]?.includes("Memory item number 15"), "Newest memory (item 15) must appear first");
    assert.ok(lines[lines.length - 1]?.includes("Memory item number 06"), "Oldest included memory should be item 06");
    assert.ok(!boundedContext.includes("Memory item number 01"), "Older memory beyond limit must be excluded");
    assert.ok(!boundedContext.includes("Memory item number 05"), "Older memory beyond limit must be excluded");
    console.log(`✓ Bounded retrieval verified: exactly ${env.AI_MAX_MEMORY_CONTEXT} newest memories retained; older items excluded`);

    // -------------------------------------------------------------
    // Test 7: Client cannot override memory limit (rejected with 400)
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing client override prevention...");
    const clientOverrideBody = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "Trying to override memory limits",
        memoryLimit: 50,
      }),
    });
    assert.equal(clientOverrideBody.status, 400, "Body override must return 400");
    const errBodyJson = await clientOverrideBody.json();
    assert.equal(errBodyJson.error.code, "VALIDATION_ERROR");

    const clientOverrideQuery = await fetch(
      `${baseUrl}/api/v1/ai/chat?AI_MAX_MEMORY_CONTEXT=100&limit=50`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Trying query override",
        }),
      },
    );
    assert.equal(clientOverrideQuery.status, 400, "Query override must return 400");
    console.log("✓ Client override attempts strictly rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 9: Memory context respects F13 character budget (AI_MAX_CONTEXT_CHARS)
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing memory context respects F13 character budgeting...");
    // Clean memories and create a large memory (1,000 chars)
    await Memory.deleteMany({ userId: userAId });
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.INSTRUCTION,
      content: "X".repeat(1000),
      status: MEMORY_STATUSES.ACTIVE,
    });

    // Test buildConversationContext with small maxChars = 200
    const contextBudgetedTest = await orchestratorService.buildConversationContext(
      convAId,
      10,
      200,
      await memoryService.getActiveMemoryContextForUser(userAId, 10),
    );

    assert.ok(contextBudgetedTest.length > 0);
    const totalChars = contextBudgetedTest.reduce((sum, m) => sum + m.content.length, 0);
    assert.ok(
      totalChars <= 200,
      `Total context characters (${totalChars}) must not exceed maxChars (200)`,
    );
    console.log(`✓ Character budget respected: total context chars (${totalChars}) <= 200`);

    // -------------------------------------------------------------
    // Test 10: Latest user message is not duplicated
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing latest user message is not duplicated...");
    await Memory.deleteMany({ userId: userAId });
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "User likes clean code",
      status: MEMORY_STATUSES.ACTIVE,
    });

    const uniquePhrase = "UniqueVerificationPromptCheckXYZ";
    await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: uniquePhrase,
      }),
    });

    const occurrences = mockProvider.capturedMessages.filter((m) =>
      m.content.includes(uniquePhrase),
    );
    assert.equal(
      occurrences.length,
      1,
      "Latest user message prompt must appear exactly once in the provider context",
    );
    console.log("✓ Latest user message is not duplicated in context");

    // -------------------------------------------------------------
    // Test 11: Normal AI chat works when user has no memories
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing normal chat works when user has 0 memories...");
    await Memory.deleteMany({ userId: userBId });
    const noMemRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "Chatting without memories",
      }),
    });
    assert.equal(noMemRes.status, 200);
    const noMemJson = await noMemRes.json();
    assert.equal(noMemJson.success, true);
    assert.equal(noMemJson.data.userMessage.content, "Chatting without memories");
    const lastCaptured = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.equal(
      lastCaptured.content,
      "Chatting without memories",
      "When user has 0 memories, message content is passed directly without memory prefix",
    );
    console.log("✓ Normal AI chat functions seamlessly with 0 memories");

    // -------------------------------------------------------------
    // Test 12: Memory retrieval failure does NOT break AI chat (Fail-open)
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing fail-open semantics when memory retrieval throws...");
    // Temporarily stub Memory.find to simulate database outage during memory fetch
    const originalFind = Memory.find;
    const balanceBeforeGlitch = (await tokenService.getBalance(userAId)).balance;

    try {
      // @ts-expect-error - Stubbing for failure injection
      Memory.find = () => {
        throw new Error("Simulated MongoDB memory collection query timeout");
      };

      const failOpenRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Proceed even if memory retrieval fails",
        }),
      });

      assert.equal(
        failOpenRes.status,
        200,
        "AI chat must NOT fail when optional memory retrieval fails",
      );
      const failOpenJson = await failOpenRes.json();
      assert.equal(failOpenJson.success, true);
      assert.equal(failOpenJson.data.userMessage.status, MESSAGE_STATUSES.COMPLETED);
      assert.ok(failOpenJson.data.assistantMessage.content);

      const balanceAfterGlitch = (await tokenService.getBalance(userAId)).balance;
      assert.equal(balanceAfterGlitch, balanceBeforeGlitch - 1, "Credit should be deducted normally");
      console.log("✓ Fail-open verified: chat completed with 200 OK despite memory retrieval error");
    } finally {
      // @ts-expect-error - Restore
      Memory.find = originalFind;
    }

    // -------------------------------------------------------------
    // Test 13: Provider failure still triggers refund & failure status
    // -------------------------------------------------------------
    console.log("\n[Test 13] Testing provider failure still triggers credit refund...");
    mockProvider.shouldFail = true;
    const balanceBeforeFail = (await tokenService.getBalance(userAId)).balance;

    const providerFailRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "This prompt should fail at the provider",
      }),
    });

    assert.equal(providerFailRes.status, 502, "Provider failure must return 502");
    const balanceAfterFail = (await tokenService.getBalance(userAId)).balance;
    assert.equal(
      balanceAfterFail,
      balanceBeforeFail,
      "Credit must be refunded on provider failure",
    );
    mockProvider.shouldFail = false;
    console.log("✓ Upstream provider failure correctly refunded credits and marked message FAILED");

    console.log("\n==================================================");
    console.log(" ALL M3 MEMORY AI CONTEXT TESTS PASSED (13/13)   ");
    console.log("==================================================");
  } finally {
    // Teardown test data
    try {
      const users = await User.find({
        email: { $in: [userAEmail, userBEmail] },
      });
      const userIds = users.map((u) => u._id);

      if (userIds.length > 0) {
        await Memory.deleteMany({ userId: { $in: userIds } });
        await Message.deleteMany({ userId: { $in: userIds } });
        await Conversation.deleteMany({ userId: { $in: userIds } });
        await TokenBalance.deleteMany({ userId: { $in: userIds } });
        await User.deleteMany({ _id: { $in: userIds } });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("M3 Test Suite Failed:", err);
  process.exit(1);
});
