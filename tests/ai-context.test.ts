import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User } from "../src/modules/users/user.model.js";
import {
  Conversation,
  CONVERSATION_STATUSES,
} from "../src/modules/conversations/conversation.model.js";
import {
  Message,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as messageRepository from "../src/modules/messages/message.repository.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class ContextTestMockProvider implements AIProvider {
  public readonly name = "mock-context-provider";
  public callCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-context-provider",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Assistant response #${this.callCount}`,
      provider: "mock-context-provider",
      model: "mock-model",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting F13: AI Context Window Protection Test Suite ===");
  await connectDatabase();

  const mockProvider = new ContextTestMockProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testTimestamp = Date.now();
  const userAEmail = `context_user_a_${testTimestamp}@example.com`;
  const userBEmail = `context_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let conversationAId = "";
  let conversationBId = "";

  try {
    const regA = await authService.register({
      email: userAEmail,
      password: testPassword,
    });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({
      email: userBEmail,
      password: testPassword,
    });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    const convA = await conversationService.createConversation(userAId, {
      title: "Context Test Conv A",
    });
    conversationAId = convA._id.toString();

    const convB = await conversationService.createConversation(userBId, {
      title: "Context Test Conv B",
    });
    conversationBId = convB._id.toString();

    // -------------------------------------------------------------
    // Test 1: Empty conversation returns empty context
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing empty conversation context...");
    const emptyContext = await orchestratorService.buildConversationContext(
      conversationAId,
      10,
      1000,
    );
    assert.deepEqual(
      emptyContext,
      [],
      "Empty conversation must return empty context array",
    );
    console.log("✓ Empty conversation returns empty context array");

    // -------------------------------------------------------------
    // Test 2: findRecentMessagesForContext limits and sorts correctly
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing findRecentMessagesForContext bounding and ordering...");
    // Seed 8 messages: 4 user and 4 assistant alternating
    const seededMessages = [];
    const baseDate = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 8; i++) {
      const isUser = i % 2 === 0;
      const createdAt = new Date(baseDate.getTime() + i * 60000);
      const msg = await Message.create({
        conversationId: conversationAId,
        userId: userAId,
        role: isUser ? MESSAGE_ROLES.USER : MESSAGE_ROLES.ASSISTANT,
        content: `Message ${i + 1}`,
        status: MESSAGE_STATUSES.COMPLETED,
        createdAt,
        updatedAt: createdAt,
      });
      seededMessages.push(msg);
    }

    // Query with limit 4: should return the 4 most recent (messages 5, 6, 7, 8) in chronological order
    const recent4 = await messageRepository.findRecentMessagesForContext(
      conversationAId,
      4,
    );
    assert.equal(recent4.length, 4, "Should return exactly 4 messages");
    assert.equal(recent4[0]?.content, "Message 5", "First returned should be Message 5");
    assert.equal(recent4[1]?.content, "Message 6", "Second returned should be Message 6");
    assert.equal(recent4[2]?.content, "Message 7", "Third returned should be Message 7");
    assert.equal(recent4[3]?.content, "Message 8", "Fourth returned should be Message 8");
    console.log("✓ findRecentMessagesForContext correctly bounds to limit and preserves chronological order");

    // -------------------------------------------------------------
    // Test 3: buildConversationContext respects maxMessages
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing buildConversationContext message count limiting...");
    const context4 = await orchestratorService.buildConversationContext(
      conversationAId,
      4,
      50000,
    );
    assert.equal(context4.length, 4, "Context should contain 4 messages");
    assert.equal(context4[0]?.content, "Message 5");
    assert.equal(context4[1]?.content, "Message 6");
    assert.equal(context4[2]?.content, "Message 7");
    assert.equal(context4[3]?.content, "Message 8");
    assert.equal(context4[3]?.role, "assistant");
    console.log("✓ buildConversationContext excluded older messages and retained 4 recent messages");

    // -------------------------------------------------------------
    // Test 4: buildConversationContext character budgeting drops older messages
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing character budget pruning...");
    // Messages 5..8 have contents: "Message 5" (9 chars), "Message 6" (9 chars), "Message 7" (9 chars), "Message 8" (9 chars)
    // Total for all 4 is 36 chars.
    // If maxChars = 20:
    // Message 8 is latest (9 chars). Remaining = 20 - 9 = 11 chars.
    // Message 7 takes 9 chars. Remaining = 11 - 9 = 2 chars.
    // Message 6 takes 9 chars > 2 chars -> cannot fit, dropped!
    // Message 5 dropped!
    // Result should be: [Message 7, Message 8]
    const budgetedContext = await orchestratorService.buildConversationContext(
      conversationAId,
      4,
      20,
    );
    assert.equal(
      budgetedContext.length,
      2,
      "Should retain only 2 messages within the 20-character budget",
    );
    assert.equal(budgetedContext[0]?.content, "Message 7");
    assert.equal(budgetedContext[1]?.content, "Message 8");
    console.log("✓ Older messages dropped to satisfy character budget while preserving latest messages");

    // -------------------------------------------------------------
    // Test 5: Single message exceeding character budget is safely capped
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing capping of oversized latest message...");
    // If maxChars = 5: Message 8 has 9 chars, so it should be capped to 5 chars: "Messa"
    const cappedContext = await orchestratorService.buildConversationContext(
      conversationAId,
      4,
      5,
    );
    assert.equal(cappedContext.length, 1, "Should retain only the latest message");
    assert.equal(cappedContext[0]?.content, "Messa", "Content should be truncated to maxChars (5)");
    assert.equal(cappedContext[0]?.content.length, 5);
    console.log("✓ Oversized latest message safely capped to maxChars");

    // -------------------------------------------------------------
    // Test 6: FAILED messages are excluded from context
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing exclusion of FAILED messages...");
    const failedCreatedAt = new Date(baseDate.getTime() + 10 * 60000);
    await Message.create({
      conversationId: conversationAId,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Failed user prompt",
      status: MESSAGE_STATUSES.FAILED,
      createdAt: failedCreatedAt,
      updatedAt: failedCreatedAt,
    });
    const contextExcludingFailed = await orchestratorService.buildConversationContext(
      conversationAId,
      10,
      50000,
    );
    const hasFailedMsg = contextExcludingFailed.some(
      (m) => m.content === "Failed user prompt",
    );
    assert.equal(hasFailedMsg, false, "FAILED status messages must not be in context");
    console.log("✓ FAILED messages excluded from context");

    // Clean up conversation A seeded messages for subsequent HTTP tests
    await Message.deleteMany({ conversationId: conversationAId });

    // -------------------------------------------------------------
    // Test 7: HTTP End-to-end chat turn includes latest user message and no duplication
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing HTTP chat turn 1...");
    const chatRes1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Hello AI",
      }),
    });
    assert.equal(chatRes1.status, 200);
    assert.equal(mockProvider.capturedMessages.length, 1);
    assert.deepEqual(mockProvider.capturedMessages[0], {
      role: "user",
      content: "Hello AI",
    });
    console.log("✓ First turn passed user message directly to provider");

    // -------------------------------------------------------------
    // Test 8: HTTP End-to-end chat turn 2 verifies history + latest message order
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing HTTP chat turn 2 (conversation history + latest user message)...");
    const chatRes2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Tell me a joke",
      }),
    });
    assert.equal(chatRes2.status, 200);
    assert.equal(mockProvider.capturedMessages.length, 3);
    assert.equal(mockProvider.capturedMessages[0]?.role, "user");
    assert.equal(mockProvider.capturedMessages[0]?.content, "Hello AI");
    assert.equal(mockProvider.capturedMessages[1]?.role, "assistant");
    assert.equal(mockProvider.capturedMessages[1]?.content, "Assistant response #1");
    assert.equal(mockProvider.capturedMessages[2]?.role, "user");
    assert.ok(mockProvider.capturedMessages[2]?.content.includes("Tell me a joke"));

    // Verify latest message is not duplicated
    const userJokeOccurrences = mockProvider.capturedMessages.filter(
      (m) => m.content.includes("Tell me a joke"),
    );
    assert.equal(
      userJokeOccurrences.length,
      1,
      "Latest user message must not be duplicated in the prompt context",
    );
    console.log("✓ Turn 2 passed strictly ordered history with latest message as the final item and no duplication");

    // -------------------------------------------------------------
    // Test 9: Oversized message caps LLM context while preserving database integrity
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing database state integrity with large message...");
    // Build a message with 35,000 characters (exceeds default AI_MAX_CONTEXT_CHARS=32000)
    const largeContent = "A".repeat(35000);
    const chatRes3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: largeContent,
      }),
    });
    assert.equal(chatRes3.status, 200);

    // Verify context sent to provider capped to env.AI_MAX_CONTEXT_CHARS
    const latestCaptured =
      mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1];
    assert.ok(latestCaptured, "Captured message must exist");
    assert.equal(
      latestCaptured.content.length,
      env.AI_MAX_CONTEXT_CHARS,
      `Context message content should be capped to ${env.AI_MAX_CONTEXT_CHARS}`,
    );

    // Verify MongoDB message document still has full 35,000 characters
    const chatJson3 = await chatRes3.json();
    const persistedUserMsg = await Message.findById(chatJson3.data.userMessage.id);
    assert.ok(persistedUserMsg, "Persisted message must exist in MongoDB");
    assert.equal(
      persistedUserMsg.content.length,
      35000,
      "Database message must retain original untruncated 35000 chars",
    );
    assert.equal(
      persistedUserMsg.status,
      MESSAGE_STATUSES.COMPLETED,
      "Database message status must remain COMPLETED",
    );
    console.log("✓ Context window capped safely while MongoDB message record preserved full untruncated content");

    // -------------------------------------------------------------
    // Test 10: Client override prevention in body
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing rejection of client override parameters in body...");
    const overrideAttempts = [
      { maxMessages: 50 },
      { maxChars: 100000 },
      { limit: 100 },
      { historyLimit: 10 },
      { contextWindow: 5000 },
    ];

    for (const extraProp of overrideAttempts) {
      const overrideRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: conversationAId,
          content: "Testing client override",
          ...extraProp,
        }),
      });

      assert.equal(
        overrideRes.status,
        400,
        `Request with ${Object.keys(extraProp)[0]} should be rejected with 400`,
      );
      const errJson = await overrideRes.json();
      assert.equal(
        errJson.error.code,
        "VALIDATION_ERROR",
        "Error code should be VALIDATION_ERROR",
      );
    }
    console.log("✓ All client override attempts in body rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 11: Client override prevention in query params
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing rejection of client override query parameters...");
    const queryOverrideRes = await fetch(
      `${baseUrl}/api/v1/ai/chat?maxMessages=100&limit=50`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: conversationAId,
          content: "Testing query override",
        }),
      },
    );
    assert.equal(
      queryOverrideRes.status,
      400,
      "Request with query params must be rejected with 400",
    );
    const queryErrJson = await queryOverrideRes.json();
    assert.equal(queryErrJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Query parameter override rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 12: Ownership check prevents cross-user conversation access
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing conversation ownership protection...");
    const crossUserRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "User B trying to access User A conversation",
      }),
    });
    assert.equal(crossUserRes.status, 404);
    const crossUserJson = await crossUserRes.json();
    assert.equal(crossUserJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Cross-user chat attempt rejected with 404 CONVERSATION_NOT_FOUND");

    console.log("\n==================================================");
    console.log(" ALL F13 AI CONTEXT WINDOW TESTS PASSED (12/12)   ");
    console.log("==================================================");
  } finally {
    try {
      const users = await User.find({
        email: { $in: [userAEmail, userBEmail] },
      });
      const ids = users.map((u) => u._id);
      if (ids.length > 0) {
        await TokenBalance.deleteMany({ userId: { $in: ids } });
        await Message.deleteMany({ userId: { $in: ids } });
        await Conversation.deleteMany({ userId: { $in: ids } });
        await User.deleteMany({ _id: { $in: ids } });
      }
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
