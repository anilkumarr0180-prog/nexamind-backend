import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockCrossContextAIProvider implements AIProvider {
  public readonly name = "mock-cross-context-ai";
  public callCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-cross-context-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Mock Assistant response #${this.callCount}`,
      provider: "mock-cross-context-ai",
      model: "mock-model",
      usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
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
      content: "Streaming cross-context response",
      model: "mock-model",
    };

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Batch 3: Cross-Conversation Context Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockCrossContextAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `cross_ctx_a_${testTimestamp}@example.com`;
  const userBEmail = `cross_ctx_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let conv1Id = "";
  let conv2Id = "";
  let userBConvId = "";

  try {
    // 1. Setup Users
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    await tokenService.refundCredits(userAId, 20);
    await tokenService.refundCredits(userBId, 20);

    // 2. Setup User A Conversation 1 with completed messages
    const conv1 = await conversationService.createConversation(userAId, {
      title: "Backend Architecture Design",
    });
    conv1Id = conv1._id.toString();

    await Message.create({
      conversationId: conv1Id,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Let us design the database and auth layers.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    await Message.create({
      conversationId: conv1Id,
      userId: userAId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "We completed the user schema and JWT authentication. Next step is role-based access control.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    await Conversation.findByIdAndUpdate(conv1Id, {
      messageCount: 2,
      lastMessageAt: new Date(),
    });

    // 3. Setup User A Long-term Memories
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "User prefers TypeScript, Express, and PostgreSQL",
      status: MEMORY_STATUSES.ACTIVE,
    });

    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.PREFERENCE,
      content: "Prefers concise modular code architecture",
      status: MEMORY_STATUSES.ACTIVE,
    });

    // Setup User A Conversation 2 (New Chat)
    const conv2 = await conversationService.createConversation(userAId, {
      title: "New Chat Session",
    });
    conv2Id = conv2._id.toString();

    // Setup User B Conversation
    const convB = await conversationService.createConversation(userBId, {
      title: "User B Private Chat",
    });
    userBConvId = convB._id.toString();

    // -------------------------------------------------------------
    // Test 1: Cross-Conversation Memory & History Retrieval in New Chat
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing cross-conversation context injection in new conversation...");
    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "What tools do I like to use?",
      }),
    });

    assert.equal(res1.status, 200, "Must return 200 OK");
    assert.equal(mockProvider.capturedMessages.length, 1);
    const captured1 = mockProvider.capturedMessages[0]!;
    assert.equal(captured1.role, "user");

    // Must include memories
    assert.ok(
      captured1.content.includes("Relevant user memories:"),
      "Context must include relevant user memories header",
    );
    assert.ok(
      captured1.content.includes("TypeScript, Express, and PostgreSQL"),
      "Context must include fact memory",
    );

    // Must include recent other conversation history
    assert.ok(
      captured1.content.includes("Recent conversation history:"),
      "Context must include recent conversation history header",
    );
    assert.ok(
      captured1.content.includes("Backend Architecture Design"),
      "Context must include previous conversation title",
    );
    assert.ok(
      captured1.content.includes("role-based access control"),
      "Context must include previous conversation last message excerpt",
    );
    assert.ok(
      captured1.content.endsWith("What tools do I like to use?"),
      "Context must end with original user query",
    );
    console.log("✓ Test 1 Passed: Both long-term memories and previous conversation history injected into new chat");

    // -------------------------------------------------------------
    // Test 2: Natural Query: "Where did we leave off?"
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing natural query 'Where did we leave off?'...");
    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "Where did we leave off?",
      }),
    });

    assert.equal(res2.status, 200);
    const captured2 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured2.content.includes("Recent conversation history:"),
      "Prompt must receive recent conversation history",
    );
    assert.ok(
      captured2.content.includes("Backend Architecture Design"),
      "Prompt must reference previous conversation topic",
    );
    assert.ok(
      captured2.content.includes("role-based access control"),
      "Prompt must reference last work state",
    );
    assert.ok(
      captured2.content.endsWith("Where did we leave off?"),
      "Prompt ends with natural query",
    );
    console.log("✓ Test 2 Passed: Natural query 'Where did we leave off?' receives full cross-conversation context");

    // -------------------------------------------------------------
    // Test 3: Natural Query: "What do you remember about me?"
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing natural query 'What do you remember about me?'...");
    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "What do you remember about me?",
      }),
    });

    assert.equal(res3.status, 200);
    const captured3 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured3.content.includes("Relevant user memories:"),
      "Prompt must receive user memories header",
    );
    assert.ok(
      captured3.content.includes("TypeScript, Express, and PostgreSQL"),
      "Prompt must receive factual memories about the user",
    );
    assert.ok(
      captured3.content.includes("Prefers concise modular code architecture"),
      "Prompt must receive user preferences",
    );
    console.log("✓ Test 3 Passed: Natural query 'What do you remember about me?' receives persisted user memories");

    // -------------------------------------------------------------
    // Test 4: Cross-User Isolation (Zero Leakage)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user isolation (zero leakage between users)...");
    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: userBConvId,
        content: "Where did we leave off?",
      }),
    });

    assert.equal(res4.status, 200);
    const captured4 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    // User B must NOT see User A's memories or conversation history
    assert.ok(
      !captured4.content.includes("Backend Architecture Design"),
      "User B must not see User A's conversation title",
    );
    assert.ok(
      !captured4.content.includes("role-based access control"),
      "User B must not see User A's conversation messages",
    );
    assert.ok(
      !captured4.content.includes("TypeScript, Express, and PostgreSQL"),
      "User B must not see User A's memories",
    );
    console.log("✓ Test 4 Passed: Zero cross-user leakage; User B receives no access to User A's history or memories");

    // -------------------------------------------------------------
    // Test 5: Soft-Deleted Conversations & Memories Are Strictly Excluded
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing soft-deleted conversations and memories are excluded...");
    const deletedConv = await conversationService.createConversation(userAId, {
      title: "Secret Temporary Project",
    });
    await Message.create({
      conversationId: deletedConv._id,
      userId: userAId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Top secret project details that must never leak",
      status: MESSAGE_STATUSES.COMPLETED,
    });
    await conversationService.deleteConversation(deletedConv._id.toString(), userAId);

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "What projects did I work on?",
      }),
    });

    assert.equal(res5.status, 200);
    const captured5 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured5.content.includes("Secret Temporary Project"),
      "Soft-deleted conversation title must never appear in context",
    );
    assert.ok(
      !captured5.content.includes("Top secret project details"),
      "Soft-deleted conversation content must never appear in context",
    );
    console.log("✓ Test 5 Passed: Soft-deleted conversations are strictly excluded from context");

    // -------------------------------------------------------------
    // Test 6: Fail-Open Semantics
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing fail-open semantics when cross-conversation retrieval glitches...");
    const originalFind = Conversation.find.bind(Conversation);
    (Conversation as any).find = () => {
      throw new Error("Simulated database timeout during conversation listing");
    };

    try {
      const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: conv2Id,
          content: "Chatting with conversation fetch glitch",
        }),
      });

      assert.equal(res6.status, 200, "Chat must return 200 OK even if cross-conversation fetch fails");
      console.log("✓ Test 6 Passed: Fail-open verified; chat completes normally despite database glitch");
    } finally {
      (Conversation as any).find = originalFind;
    }

    // -------------------------------------------------------------
    // Test 7: Streaming Chat Inherits Cross-Conversation Context
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing streaming chat receives cross-conversation context...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "Streaming cross-conversation verification",
        stream: true,
      }),
    });

    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));
    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes("Streaming cross-context response"), "Stream body must contain content chunks");
    const capturedStream = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      capturedStream.content.includes("Recent conversation history:"),
      "Streaming chat must receive cross-conversation history",
    );
    assert.ok(
      capturedStream.content.includes("Relevant user memories:"),
      "Streaming chat must receive user memories",
    );
    console.log("✓ Test 7 Passed: Streaming chat seamlessly receives cross-conversation context");

    console.log("\n=============================================================");
    console.log("=== ALL CROSS-CONVERSATION CONTEXT TESTS PASSED (7/7) =======");
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
  console.error("Cross-Conversation Context Test Suite Failed:", err);
  process.exit(1);
});
