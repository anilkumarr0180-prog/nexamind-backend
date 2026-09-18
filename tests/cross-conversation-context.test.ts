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
import * as memoryService from "../src/modules/memory/memory.service.js";
import { TestMockEmbeddingProvider } from "./helpers/mock-embedding.helper.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockIsolatedAIProvider implements AIProvider {
  public readonly name = "mock-isolated-ai";
  public callCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-isolated-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Mock Assistant response #${this.callCount}`,
      provider: "mock-isolated-ai",
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
      content: "Streaming isolated response",
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
  console.log("=== Starting Strict Conversation Isolation Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockIsolatedAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const mockEmbeddingProvider = new TestMockEmbeddingProvider();
  memoryService.setDefaultEmbeddingProvider(mockEmbeddingProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `iso_a_${testTimestamp}@example.com`;
  const userBEmail = `iso_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let convAId = "";
  let convBId = "";
  let userBConvId = "";

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

    // 2. Setup User A Conversation A with "Alpha secret topic"
    const convA = await conversationService.createConversation(userAId, {
      title: "Alpha secret topic",
    });
    convAId = convA._id.toString();

    await Message.create({
      conversationId: convAId,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Alpha secret project requirements and architecture details.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    await Message.create({
      conversationId: convAId,
      userId: userAId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Alpha secret credentials: key_xyz987654321 and confidential schema.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    await Conversation.findByIdAndUpdate(convAId, {
      messageCount: 2,
      lastMessageAt: new Date(),
      summary: "Alpha secret project summary discussing key_xyz987654321.",
    });

    // 3. Setup User A Long-term Memory
    const memEmb = await mockEmbeddingProvider.generateEmbedding("User prefers TypeScript, Express, and MongoDB");
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.FACT,
      content: "User prefers TypeScript, Express, and MongoDB",
      status: MEMORY_STATUSES.ACTIVE,
      embedding: memEmb,
    });

    // 4. Setup User A Conversation B with "Beta topic"
    const convB = await conversationService.createConversation(userAId, {
      title: "Beta topic",
    });
    convBId = convB._id.toString();

    // 5. Setup User B Conversation
    const convBUser = await conversationService.createConversation(userBId, {
      title: "User B Private Chat",
    });
    userBConvId = convBUser._id.toString();

    // -------------------------------------------------------------
    // TEST 1 — Strict Conversation Isolation (Zero Contamination)
    // -------------------------------------------------------------
    console.log("\n[TEST 1] Testing strict conversation isolation in Conversation B...");
    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "Let us start working on the Beta topic.",
      }),
    });

    assert.equal(res1.status, 200, "Must return 200 OK");
    const captured1 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    
    // Must NOT contain any Conversation A data
    assert.ok(
      !captured1.content.includes("Alpha secret topic"),
      "Context must NOT contain Conversation A title",
    );
    assert.ok(
      !captured1.content.includes("Alpha secret project requirements"),
      "Context must NOT contain Conversation A user messages",
    );
    assert.ok(
      !captured1.content.includes("key_xyz987654321"),
      "Context must NOT contain Conversation A assistant messages",
    );
    assert.ok(
      !captured1.content.includes("Alpha secret project summary"),
      "Context must NOT contain Conversation A summary",
    );
    assert.ok(
      !captured1.content.includes("Recent conversation history:"),
      "Context must NOT contain Recent conversation history header",
    );
    // Must contain current query
    assert.ok(
      captured1.content.includes("Let us start working on the Beta topic."),
      "Context must contain current query",
    );
    console.log("✓ TEST 1 Passed: Conversation B context is strictly isolated with ZERO contamination from Conversation A");

    // -------------------------------------------------------------
    // TEST 2 — Cross-User Isolation (Zero Cross-User Leakage)
    // -------------------------------------------------------------
    console.log("\n[TEST 2] Testing cross-user isolation...");
    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
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

    assert.equal(res2.status, 200);
    const captured2 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured2.content.includes("Alpha secret"),
      "User B must not see User A conversation data",
    );
    assert.ok(
      !captured2.content.includes("Beta topic"),
      "User B must not see User A other conversations",
    );
    assert.ok(
      !captured2.content.includes("TypeScript, Express, and MongoDB"),
      "User B must not see User A memories",
    );
    console.log("✓ TEST 2 Passed: Cross-user isolation verified; User B sees 0 User A data");

    // -------------------------------------------------------------
    // TEST 3 — Memory Still Works Across Different Conversations
    // -------------------------------------------------------------
    console.log("\n[TEST 3] Testing user memory reaches LLM in Conversation B...");
    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "What tech stack do I use?",
      }),
    });

    assert.equal(res3.status, 200);
    const captured3 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured3.content.includes("Relevant user memories:"),
      "Context must include relevant user memories header",
    );
    assert.ok(
      captured3.content.includes("TypeScript, Express, and MongoDB"),
      "Context must include user factual memory",
    );
    // And still isolated from Conversation A
    assert.ok(
      !captured3.content.includes("Alpha secret"),
      "Must still exclude Conversation A",
    );
    console.log("✓ TEST 3 Passed: User memory reaches LLM cleanly across conversations through memory system");

    // -------------------------------------------------------------
    // TEST 4 — Current Conversation Messages Still Work
    // -------------------------------------------------------------
    console.log("\n[TEST 4] Testing active conversation history is preserved...");
    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "What was the previous question I asked in this chat?",
      }),
    });

    assert.equal(res4.status, 200);
    const messagesInContext = mockProvider.capturedMessages;
    assert.ok(messagesInContext.length >= 2, "Must contain previous turns from active conversation");
    const hasPreviousTurn = messagesInContext.some((m) =>
      m.content.includes("What tech stack do I use?") || m.content.includes("Let us start working on the Beta topic.")
    );
    assert.ok(hasPreviousTurn, "Active conversation recent messages must remain in context");
    console.log("✓ TEST 4 Passed: Active conversation history is properly maintained in context");

    // -------------------------------------------------------------
    // TEST 5 — Conversation Summary Still Works for Current Conversation
    // -------------------------------------------------------------
    console.log("\n[TEST 5] Testing active conversation summary is included...");
    await Conversation.findByIdAndUpdate(convBId, {
      summary: "Active discussion regarding Beta topic setup and tech stack choice.",
    });

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "Continue with the plan.",
      }),
    });

    assert.equal(res5.status, 200);
    const captured5 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
        assert.ok(
      captured5.content.includes("Conversation summary:"),
      "Context must include active conversation summary header",
    );
    assert.ok(
      captured5.content.includes("Conversation summary:"),
      "Context must include active conversation summary header",
    );
    assert.ok(
      !captured5.content.includes("Alpha secret project summary"),
      "Must NOT include other conversation summary",
    );
    console.log("✓ TEST 5 Passed: Active conversation summary correctly reaches LLM without cross-talk");

    // -------------------------------------------------------------
    // TEST 6 — Context-Window Protection & Character Budgeting
    // -------------------------------------------------------------
    console.log("\n[TEST 6] Testing context-window character budgeting...");
    const longPrompt = "X".repeat(5000);
    const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: longPrompt,
      }),
    });

    assert.equal(res6.status, 200);
    const captured6 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured6.content.length <= env.AI_MAX_CONTEXT_CHARS,
      `Total character count (${captured6.content.length}) must not exceed env.AI_MAX_CONTEXT_CHARS (${env.AI_MAX_CONTEXT_CHARS})`,
    );
    console.log("✓ TEST 6 Passed: Context-window character budgeting enforced cleanly");

    // -------------------------------------------------------------
    // TEST 7 — Streaming Chat Strictly Respects Isolation
    // -------------------------------------------------------------
    console.log("\n[TEST 7] Testing streaming chat respects strict conversation isolation...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convBId,
        content: "Streaming isolation verification for TypeScript stack",
        stream: true,
      }),
    });

    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));
    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes("Streaming isolated response"), "Stream body must contain content chunks");
    const capturedStream = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    
    assert.ok(
      !capturedStream.content.includes("Alpha secret"),
      "Streaming context must NOT contain other conversation data",
    );
    assert.ok(
      !capturedStream.content.includes("Recent conversation history:"),
      "Streaming context must NOT contain cross-conversation history header",
    );
    assert.ok(
      capturedStream.content.includes("Relevant user memories:"),
      "Streaming context preserves legitimate user memories",
    );
    console.log("✓ TEST 7 Passed: Streaming chat strictly respects isolation while preserving user memories");

    console.log("\n=============================================================");
    console.log("=== ALL STRICT CONVERSATION ISOLATION TESTS PASSED (7/7) ====");
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
  console.error("Strict Conversation Isolation Test Suite Failed:", err);
  process.exit(1);
});
