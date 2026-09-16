import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import aiRoutes from "../src/modules/ai/ai.routes.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockAIProvider implements AIProvider {
  public readonly name = "mock-ai";
  public callCount = 0;
  public shouldFail = false;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.callCount++;
    this.capturedMessages = messages;

    if (this.shouldFail) {
      throw new Error("Simulated upstream provider outage");
    }

    return {
      content: "Hello! I am NexaMind AI assistant.",
      provider: "mock-ai",
      model: "mock-llama3",
      usage: {
        inputTokens: 14,
        outputTokens: 28,
        totalTokens: 42,
      },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting AI Orchestrator & Regression Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `orch_user_a_${testTimestamp}@example.com`;
  const userBEmail = `orch_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let conversationAId = "";

  try {
    // Setup users
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

    // Create active conversation for User A
    const convA = await conversationService.createConversation(userAId, {
      title: "Orchestrator Test Conversation",
    });
    conversationAId = convA._id.toString();

    // -------------------------------------------------------------
    // Test 1: Successful Chat Request
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing Successful Chat Request...");
    const initialBalanceA = await tokenService.getBalance(userAId);
    const expectedBalanceAfterChat = initialBalanceA.balance - 1;

    const chatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "What is machine learning?",
      }),
    });

    assert.equal(chatRes.status, 200, "Successful chat request should return 200");
    const chatJson = await chatRes.json();
    assert.equal(chatJson.success, true);
    assert.ok(chatJson.data.conversation, "Response should have conversation data");
    assert.ok(chatJson.data.userMessage, "Response should have userMessage data");
    assert.ok(chatJson.data.assistantMessage, "Response should have assistantMessage data");
    assert.ok(chatJson.data.usage, "Response should have usage data");

    const newBalanceA = await tokenService.getBalance(userAId);
    assert.equal(newBalanceA.balance, expectedBalanceAfterChat, "1 credit should be deducted");
    console.log("✓ Successful chat request returned 200 and deducted 1 credit");

    // -------------------------------------------------------------
    // Test 2: Unauthenticated Request
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing Unauthenticated Request...");
    const unauthRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Hello",
      }),
    });
    assert.equal(unauthRes.status, 401, "Unauthenticated request should return 401");
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.error.code, "UNAUTHORIZED");
    console.log("✓ Unauthenticated request rejected with 401 UNAUTHORIZED");

    // -------------------------------------------------------------
    // Test 3: Invalid Conversation ID Format
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing Invalid Conversation ID Format...");
    const invalidIdRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: "invalid-not-an-objectid",
        content: "Hello",
      }),
    });
    assert.equal(invalidIdRes.status, 400, "Invalid conversation ID should return 400");
    const invalidIdJson = await invalidIdRes.json();
    assert.equal(invalidIdJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Invalid conversation ID rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 4: Conversation Not Found
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing Conversation Not Found...");
    const fakeConvId = "507f1f77bcf86cd799439011";
    const notFoundRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: fakeConvId,
        content: "Hello",
      }),
    });
    assert.equal(notFoundRes.status, 404, "Non-existent conversation should return 404");
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Non-existent conversation rejected with 404 CONVERSATION_NOT_FOUND");

    // -------------------------------------------------------------
    // Test 5: Cross-User Conversation Access
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing Cross-User Conversation Access...");
    const crossUserRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`, // User B token trying to access User A conversation
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "I am trying to hijack conversation A",
      }),
    });
    assert.equal(crossUserRes.status, 404, "Cross-user conversation access should return 404");
    const crossUserJson = await crossUserRes.json();
    assert.equal(crossUserJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Cross-user access rejected with 404 CONVERSATION_NOT_FOUND");

    // -------------------------------------------------------------
    // Test 6: Archived Conversation Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing Archived Conversation Rejection...");
    const archivedConv = await conversationService.createConversation(userAId, {
      title: "To Be Archived",
    });
    await conversationService.archiveConversation(archivedConv._id.toString(), userAId);

    const archivedRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: archivedConv._id.toString(),
        content: "Hello archived",
      }),
    });
    assert.equal(archivedRes.status, 400, "Archived conversation should return 400");
    const archivedJson = await archivedRes.json();
    assert.equal(archivedJson.error.code, "CONVERSATION_ARCHIVED");
    console.log("✓ Archived conversation rejected with 400 CONVERSATION_ARCHIVED");

    // -------------------------------------------------------------
    // Test 7: Deleted Conversation Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing Deleted Conversation Rejection...");
    const deletedConv = await conversationService.createConversation(userAId, {
      title: "To Be Deleted",
    });
    await conversationService.deleteConversation(deletedConv._id.toString(), userAId);

    const deletedRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: deletedConv._id.toString(),
        content: "Hello deleted",
      }),
    });
    assert.equal(deletedRes.status, 404, "Deleted conversation should return 404");
    const deletedJson = await deletedRes.json();
    assert.equal(deletedJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Soft-deleted conversation treated as unavailable (404)");

    // -------------------------------------------------------------
    // Test 8: Empty Message Content
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing Empty Message Content...");
    const emptyMsgRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "   ",
      }),
    });
    assert.equal(emptyMsgRes.status, 400, "Empty content should return 400");
    const emptyMsgJson = await emptyMsgRes.json();
    assert.equal(emptyMsgJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Empty message rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 9: Oversized Message Content
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing Oversized Message Content...");
    const hugeContent = "A".repeat(100001);
    const oversizedRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: hugeContent,
      }),
    });
    assert.equal(oversizedRes.status, 400, "Oversized content should return 400");
    const oversizedJson = await oversizedRes.json();
    assert.equal(oversizedJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Message exceeding 100,000 characters rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 10: Unexpected Request Fields
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing Unexpected Request Fields...");
    const unexpectedFieldsRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Valid content",
        role: "ASSISTANT",
        provider: "malicious-provider",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        balance: 999999,
        userId: "hacked",
      }),
    });
    assert.equal(unexpectedFieldsRes.status, 400, "Unexpected fields should return 400");
    const unexpectedJson = await unexpectedFieldsRes.json();
    assert.equal(unexpectedJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Client attempt to inject role/provider/usage/userId rejected with 400");

    // -------------------------------------------------------------
    // Test 11 & 12: Insufficient Credits & Provider Not Called
    // -------------------------------------------------------------
    console.log("\n[Test 11 & 12] Testing Insufficient Credits & Provider Not Called...");
    // Drain User B's balance to 0
    const userBBalance = await tokenService.getBalance(userBId);
    await tokenService.deductCredits(userBId, userBBalance.balance);
    const zeroBalance = await tokenService.getBalance(userBId);
    assert.equal(zeroBalance.balance, 0, "User B balance should now be 0");

    // Create conversation for User B
    const convB = await conversationService.createConversation(userBId, {
      title: "User B Zero Balance Conv",
    });

    const callCountBefore = mockProvider.callCount;

    const noCreditsRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: convB._id.toString(),
        content: "Can I chat with no credits?",
      }),
    });

    assert.equal(noCreditsRes.status, 402, "Insufficient credits should return 402");
    const noCreditsJson = await noCreditsRes.json();
    assert.equal(noCreditsJson.error.code, "INSUFFICIENT_CREDITS");

    const callCountAfter = mockProvider.callCount;
    assert.equal(callCountAfter, callCountBefore, "AI Provider must NOT be called when credits are insufficient");
    console.log("✓ Zero credits rejected with 402 INSUFFICIENT_CREDITS and AI Provider was NOT called");

    // -------------------------------------------------------------
    // Test 13, 14, 15, 16: Persistence & Metadata Verification
    // -------------------------------------------------------------
    console.log("\n[Test 13 - 16] Testing Persistence & Metadata Accuracy...");
    const messages = await Message.find({ conversationId: conversationAId }).sort({ createdAt: 1 });
    assert.ok(messages.length >= 2, "Conversation A must have at least user and assistant messages");

    const userMsg = messages[messages.length - 2];
    assert.equal(userMsg?.role, MESSAGE_ROLES.USER);
    assert.equal(userMsg?.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(userMsg?.model, null);
    assert.equal(userMsg?.provider, null);
    assert.equal(userMsg?.usage, null);
    console.log("✓ User message persisted correctly (role=USER, status=COMPLETED, model/provider=null)");

    const assistantMsg = messages[messages.length - 1];
    assert.equal(assistantMsg?.role, MESSAGE_ROLES.ASSISTANT);
    assert.equal(assistantMsg?.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(assistantMsg?.provider, "mock-ai");
    assert.equal(assistantMsg?.model, "mock-llama3");
    assert.equal(assistantMsg?.usage?.inputTokens, 14);
    assert.equal(assistantMsg?.usage?.outputTokens, 28);
    assert.equal(assistantMsg?.usage?.totalTokens, 42);
    console.log("✓ Assistant message persisted correctly with provider, model, and token usage");

    const convRecord = await Conversation.findById(conversationAId);
    assert.equal(convRecord?.messageCount, messages.length);
    assert.ok(convRecord?.lastMessageAt);
    console.log("✓ Conversation metadata updated (messageCount and lastMessageAt match database)");

    // -------------------------------------------------------------
    // Test 17 & 18: Provider Failure & Credit Refund / Consistency
    // -------------------------------------------------------------
    console.log("\n[Test 17 & 18] Testing Provider Failure & Credit Refund Compensation...");
    const balanceBeforeFailure = (await tokenService.getBalance(userAId)).balance;
    const assistantCountBefore = await Message.countDocuments({
      conversationId: conversationAId,
      role: MESSAGE_ROLES.ASSISTANT,
    });

    // Make provider fail
    mockProvider.shouldFail = true;

    const failRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "This request will trigger an AI outage",
      }),
    });

    assert.equal(failRes.status, 502, "Provider failure should return 502");
    const failJson = await failRes.json();
    assert.equal(failJson.error.code, "AI_PROVIDER_ERROR");

    // Verify credits were compensated/refunded
    const balanceAfterFailure = (await tokenService.getBalance(userAId)).balance;
    assert.equal(balanceAfterFailure, balanceBeforeFailure, "Credits must be refunded upon provider failure");

    // Verify no assistant message was created
    const assistantCountAfter = await Message.countDocuments({
      conversationId: conversationAId,
      role: MESSAGE_ROLES.ASSISTANT,
    });
    assert.equal(assistantCountAfter, assistantCountBefore, "No assistant message must be created on provider failure");
    console.log("✓ Provider failure returned 502 AI_PROVIDER_ERROR, credits were refunded, and no assistant message was created");

    // Reset mock provider
    mockProvider.shouldFail = false;

    // -------------------------------------------------------------
    // Test 19: Auth Regression
    // -------------------------------------------------------------
    console.log("\n[Test 19] Testing Auth Regression...");
    const loginRes = await authService.login({
      email: userAEmail,
      password: testPassword,
    });
    assert.ok(loginRes.accessToken);
    assert.equal(loginRes.user.id, userAId);
    console.log("✓ Auth login verified");

    // -------------------------------------------------------------
    // Test 20: Conversation CRUD Regression
    // -------------------------------------------------------------
    console.log("\n[Test 20] Testing Conversation CRUD Regression...");
    const testConv = await conversationService.createConversation(userAId, { title: "Regression Conv" });
    const convList = await conversationService.getUserConversations(userAId);
    assert.ok(convList.some((c) => c._id.toString() === testConv._id.toString()));
    const archived = await conversationService.archiveConversation(testConv._id.toString(), userAId);
    assert.equal(archived.status, CONVERSATION_STATUSES.ARCHIVED);
    const unarchived = await conversationService.unarchiveConversation(testConv._id.toString(), userAId);
    assert.equal(unarchived.status, CONVERSATION_STATUSES.ACTIVE);
    await conversationService.deleteConversation(testConv._id.toString(), userAId);
    console.log("✓ Conversation CRUD (create, read, archive, unarchive, soft-delete) verified");

    // -------------------------------------------------------------
    // Test 21: Direct Message APIs Regression
    // -------------------------------------------------------------
    console.log("\n[Test 21] Testing Direct Message APIs Regression...");
    const directMsgRes = await fetch(`${baseUrl}/api/v1/conversations/${conversationAId}/messages`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(directMsgRes.status, 200);
    const directMsgJson = await directMsgRes.json();
    assert.ok(Array.isArray(directMsgJson.data));
    console.log("✓ Message listing API verified");

    // -------------------------------------------------------------
    // Test 22: Token/Credit Engine Regression
    // -------------------------------------------------------------
    console.log("\n[Test 22] Testing Token/Credit Engine Regression...");
    const balanceCheck = await tokenService.getBalance(userAId);
    assert.ok(typeof balanceCheck.balance === "number");
    const dupInit = await tokenService.initializeBalance(userAId, 9999);
    assert.equal(dupInit.balance, balanceCheck.balance, "Duplicate initialization must be idempotent");
    console.log("✓ Token/Credit balance check and idempotent initialization verified");

    // -------------------------------------------------------------
    // Test 23: F14 Canonical Route Enforcement & Duplicate Paths Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 23] Testing F14 Canonical Route & Duplicate Paths Rejection...");

    const duplicatePaths = [
      "/api/v1/chat",
      "/api/v1/chat/chat",
      "/api/v1/ai",
    ];

    const testBody = JSON.stringify({
      conversationId: conversationAId,
      content: "Testing route isolation",
    });

    for (const dupPath of duplicatePaths) {
      // 1. Authenticated request with valid credentials and valid body to duplicate path
      // MUST return 404 Not Found, proving the route is completely unhandled and not exposed.
      const authDupRes = await fetch(`${baseUrl}${dupPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: testBody,
      });
      assert.equal(
        authDupRes.status,
        404,
        `Authenticated request to removed path '${dupPath}' must return 404 Not Found`,
      );
    }
    console.log("✓ All duplicate AI route paths (/api/v1/chat, /api/v1/chat/chat, /api/v1/ai) returned 404 for authenticated requests");

    // Verify canonical endpoint POST /api/v1/ai/chat works
    const canonicalRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Canonical endpoint verification message",
      }),
    });
    assert.equal(canonicalRes.status, 200, "Canonical endpoint POST /api/v1/ai/chat must return 200");
    console.log("✓ Canonical endpoint POST /api/v1/ai/chat confirmed fully operational");

    // -------------------------------------------------------------
    // Test 24: Express Route Registration Architecture Verification
    // -------------------------------------------------------------
    console.log("\n[Test 24] Testing Express Route Stack Architecture...");
    const appStack = (app as any).router?.stack || (app as any)._router?.stack || [];
    let aiMountCount = 0;
    let chatRouterMountCount = 0;

    for (const layer of appStack) {
      if (layer.name === "router" && layer.handle === aiRoutes) {
        aiMountCount++;
      }
    }
    assert.equal(aiMountCount, 1, "aiRoutes must be mounted exactly once on the Express app");

    const aiSubRoutes = aiRoutes.stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods).join(",").toUpperCase()} ${l.route.path}`);
    assert.deepEqual(
      aiSubRoutes,
      ["POST /chat"],
      "aiRoutes must contain exactly one sub-route: 'POST /chat'",
    );
    console.log("✓ Express route architecture confirmed: exactly 1 aiRoutes mount and 1 sub-route ('POST /chat')");

    console.log("\n==================================================");
    console.log(" ALL TESTS & REGRESSION CHECKS PASSED PERFECTLY ");
    console.log("==================================================");
  } finally {
    // Cleanup
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
