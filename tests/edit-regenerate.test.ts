import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
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
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockEditRegenerateProvider implements AIProvider {
  public readonly name = "mock-ai";
  public callCount = 0;
  public streamCallCount = 0;
  public shouldFail = false;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    if (this.shouldFail) {
      throw new Error("Simulated upstream provider failure");
    }

    return {
      content: `Mock generated response #${this.callCount}`,
      provider: "mock-ai",
      model: "mock-model",
      usage: {
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40,
      },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.streamCallCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    if (this.shouldFail) {
      throw new Error("Simulated streaming failure");
    }

    yield {
      content: "Regenerated stream chunk 1",
      model: "mock-model",
    };

    yield {
      content: " and chunk 2",
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Edit & Regenerate Comprehensive Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockEditRegenerateProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `edit_user_a_${testTimestamp}@example.com`;
  const userBEmail = `edit_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let conversationAId = "";

  try {
    // 1. Setup Users
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

    // Create Conversation for User A
    const convA = await conversationService.createConversation(userAId, {
      title: "Edit & Regenerate Test Conversation",
    });
    conversationAId = convA._id.toString();

    // -------------------------------------------------------------
    // Initial Setup: Send 2 message turns to Conversation A
    // Turn 1: User Msg 1 -> Assistant Msg 1
    // Turn 2: User Msg 2 -> Assistant Msg 2
    // -------------------------------------------------------------
    console.log("\n[Setup] Populating initial dialogue turns...");
    const turn1Res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "What is TypeScript?",
      }),
    });
    assert.equal(turn1Res.status, 200);
    const turn1Data = (await turn1Res.json()) as any;
    const userMsg1Id = turn1Data.data.userMessage.id;
    const assistantMsg1Id = turn1Data.data.assistantMessage.id;

    const turn2Res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "How does type checking work?",
      }),
    });
    assert.equal(turn2Res.status, 200);
    const turn2Data = (await turn2Res.json()) as any;
    const userMsg2Id = turn2Data.data.userMessage.id;
    const assistantMsg2Id = turn2Data.data.assistantMessage.id;

    console.log("✓ Initial 2 turns created successfully");

    // -------------------------------------------------------------
    // Test 1: Editing own user message and branch creation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing editing own user message (Turn 2)...");
    const balBeforeEdit = (await tokenService.getBalance(userAId)).balance;

    const editRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "How does type checking work in strict mode?",
        editMessageId: userMsg2Id,
      }),
    });
    assert.equal(editRes.status, 200);
    const editData = (await editRes.json()) as any;

    const newUserMsg2Id = editData.data.userMessage.id;
    const newAssistantMsg2Id = editData.data.assistantMessage.id;

    assert.notEqual(newUserMsg2Id, userMsg2Id, "New message ID must be generated for edited user message");
    assert.equal(editData.data.userMessage.content, "How does type checking work in strict mode?");
    assert.equal(editData.data.userMessage.originalMessageId, userMsg2Id, "originalMessageId must point to original message");
    assert.equal(editData.data.assistantMessage.parentMessageId, newUserMsg2Id, "New assistant message must point to new user message");
    assert.equal(editData.data.conversation.activeLeafMessageId, newAssistantMsg2Id, "Conversation active leaf must be updated to new assistant message");

    console.log("✓ Test 1 Passed: Edited user message created with correct parent, originalMessageId, and new assistant response");

    // -------------------------------------------------------------
    // Test 2: Original history is preserved non-destructively
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing original history preservation...");
    const originalMsg2 = await Message.findById(userMsg2Id);
    assert.ok(originalMsg2, "Original user message must still exist in DB");
    assert.equal(originalMsg2.content, "How does type checking work?", "Original content must remain unmodified");

    const originalAssistantMsg2 = await Message.findById(assistantMsg2Id);
    assert.ok(originalAssistantMsg2, "Original assistant message must still exist in DB");
    console.log("✓ Test 2 Passed: Original user and assistant messages remain preserved in database");

    // -------------------------------------------------------------
    // Test 3: Unauthorized edit rejection
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing unauthenticated edit rejection...");
    const unauthRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Unauthorized edit",
        editMessageId: userMsg2Id,
      }),
    });
    assert.equal(unauthRes.status, 401);
    console.log("✓ Test 3 Passed: Unauthenticated edit rejected with 401");

    // -------------------------------------------------------------
    // Test 4: Editing another user's message rejection
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user edit rejection...");
    const crossUserRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "User B trying to edit User A message",
        editMessageId: userMsg2Id,
      }),
    });
    assert.ok(crossUserRes.status === 404 || crossUserRes.status === 403, "Must reject cross-user edit with 404 or 403");
    console.log("✓ Test 4 Passed: Editing another user's message correctly rejected");

    // -------------------------------------------------------------
    // Test 5: Editing an ASSISTANT message rejection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing invalid message role rejection...");
    const assistantEditRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Editing assistant message",
        editMessageId: assistantMsg1Id,
      }),
    });
    assert.equal(assistantEditRes.status, 400);
    const err5 = (await assistantEditRes.json()) as any;
    assert.equal(err5.error.code, "INVALID_MESSAGE_ROLE");
    console.log("✓ Test 5 Passed: Editing assistant message rejected with 400 INVALID_MESSAGE_ROLE");

    // -------------------------------------------------------------
    // Test 6: Nonexistent message edit rejection
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing nonexistent message edit rejection...");
    const fakeId = "6ab3966a5745c4f342c99c99";
    const nonexistentRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Editing ghost message",
        editMessageId: fakeId,
      }),
    });
    assert.equal(nonexistentRes.status, 404);
    console.log("✓ Test 6 Passed: Nonexistent message edit rejected with 404");

    // -------------------------------------------------------------
    // Test 7: Exactly-once credit deduction
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing exactly-once credit deduction...");
    const balAfterEdit = (await tokenService.getBalance(userAId)).balance;
    assert.equal(balBeforeEdit - balAfterEdit, 1, "Exactly 1 credit must be deducted for regeneration");
    console.log("✓ Test 7 Passed: Balance decremented by exactly 1 credit");

    // -------------------------------------------------------------
    // Test 8: Insufficient credits stops before AI provider
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing insufficient credits protection...");
    const userCRes = await authService.register({
      email: `edit_user_c_${testTimestamp}@example.com`,
      password: testPassword,
    });
    const userCId = userCRes.user.id;
    const userCToken = userCRes.accessToken;

    const convC = await conversationService.createConversation(userCId, {
      title: "Zero Credits Conversation",
    });

    const userCMsg = await Message.create({
      conversationId: convC._id,
      userId: userCId,
      role: MESSAGE_ROLES.USER,
      content: "Initial prompt",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    const curBalC = (await tokenService.getBalance(userCId)).balance;
    if (curBalC > 0) {
      await tokenService.deductCredits(userCId, curBalC);
    }

    const providerCallsBefore = mockProvider.callCount;

    const zeroCredRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userCToken}`,
      },
      body: JSON.stringify({
        conversationId: convC._id.toString(),
        content: "Regenerate with no credits",
        editMessageId: userCMsg._id.toString(),
      }),
    });
    assert.equal(zeroCredRes.status, 402);
    assert.equal(mockProvider.callCount, providerCallsBefore, "AI provider must NOT be invoked when credits are insufficient");
    console.log("✓ Test 8 Passed: 402 INSUFFICIENT_CREDITS returned and AI provider not invoked");

    // -------------------------------------------------------------
    // Test 9: Provider failure refunds credit and marks user message FAILED
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing provider failure refund & user message state...");
    const balBeforeFail = (await tokenService.getBalance(userAId)).balance;
    mockProvider.shouldFail = true;

    const failRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Will fail at provider",
        editMessageId: userMsg2Id,
      }),
    });
    assert.equal(failRes.status, 502);

    mockProvider.shouldFail = false;
    const balAfterFail = (await tokenService.getBalance(userAId)).balance;
    assert.equal(balAfterFail, balBeforeFail, "Deducted credit must be refunded on provider failure");

    const failedUserMsg = await Message.findOne({
      conversationId: conversationAId,
      content: "Will fail at provider",
    });
    assert.ok(failedUserMsg, "Failed attempt user message should be recorded");
    assert.equal(failedUserMsg.status, MESSAGE_STATUSES.FAILED, "User message must be marked FAILED");
    console.log("✓ Test 9 Passed: Credit refunded and user message marked FAILED on provider failure");

    // -------------------------------------------------------------
    // Test 10: Context isolation (abandoned branch excluded from LLM prompt)
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing context isolation for active branch...");
    const captured = mockProvider.capturedMessages;
    assert.ok(captured.length >= 2, "Must receive history + new user prompt");
    const lastMsg = captured[captured.length - 1]!;
    assert.ok(lastMsg.content.includes("strict mode") || lastMsg.content.includes("Will fail"), "Latest message must be the query");

    const abandonedMsgFound = captured.some((m) =>
      m.content.includes("Mock generated response #2")
    );
    assert.equal(abandonedMsgFound, false, "Abandoned branch response must NOT be present in AI context");
    console.log("✓ Test 10 Passed: Active branch isolated; abandoned assistant response excluded from LLM context");

    // -------------------------------------------------------------
    // Test 11: Streaming regeneration
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing streaming regeneration...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "How does strict mode affect null checks?",
        editMessageId: newUserMsg2Id,
        stream: true,
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));

    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes("Regenerated stream chunk 1"), "SSE output must contain stream chunks");
    assert.ok(streamBody.includes(`"type":"done"`), "SSE output must contain done event");
    console.log("✓ Test 11 Passed: Streaming regeneration completed successfully with SSE chunks and done event");

    // -------------------------------------------------------------
    // Test 12: Normal continuation after regeneration
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing normal continuation after regeneration...");
    const continueRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "What about strictPropertyInitialization?",
      }),
    });
    assert.equal(continueRes.status, 200);
    const continueData = (await continueRes.json()) as any;

    const convAfter = await Conversation.findById(conversationAId);
    assert.equal(
      convAfter?.activeLeafMessageId?.toString(),
      continueData.data.assistantMessage.id,
      "Conversation active leaf must point to the newest assistant message"
    );
    console.log("✓ Test 12 Passed: Subsequent conversation turn correctly attached to the active branch leaf");

    // -------------------------------------------------------------
    // Test 13: Normal chat regression
    // -------------------------------------------------------------
    console.log("\n[Test 13] Testing normal chat regression...");
    const convNew = await conversationService.createConversation(userAId, {
      title: "Fresh Unbranched Conversation",
    });
    const regChatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convNew._id.toString(),
        content: "Hello NexaMind!",
      }),
    });
    assert.equal(regChatRes.status, 200);
    const regChatData = (await regChatRes.json()) as any;
    assert.ok(regChatData.data.userMessage.id);
    assert.ok(regChatData.data.assistantMessage.id);
    console.log("✓ Test 13 Passed: Standard chat without editMessageId operates flawlessly");


    // -------------------------------------------------------------
    // Test 14: Concurrent generation lock protection (409 Conflict)
    // -------------------------------------------------------------
    console.log("\n[Test 14] Testing concurrent generation lock protection...");
    let slowRelease: () => void = () => {};
    const slowPromise = new Promise<void>((resolve) => {
      slowRelease = resolve;
    });

    const originalGen = mockProvider.generateChatResponse.bind(mockProvider);
    mockProvider.generateChatResponse = async (msgs: AIMessage[]) => {
      await slowPromise;
      return originalGen(msgs);
    };

    // Fire first slow request (not awaiting)
    const firstReqPromise = fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Slow background generation",
      }),
    });

    // Give it 50ms to acquire lock
    await new Promise((r) => setTimeout(r, 50));

    // Fire second request to the same conversation
    const concurrentRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conversationAId,
        content: "Concurrent request should be rejected",
        editMessageId: userMsg2Id,
      }),
    });

    assert.equal(concurrentRes.status, 409, "Concurrent generation must return 409 Conflict");
    const err14 = (await concurrentRes.json()) as any;
    assert.equal(err14.error.code, "GENERATION_IN_PROGRESS");

    // Release slow promise and finish first request
    slowRelease();
    const firstRes = await firstReqPromise;
    assert.equal(firstRes.status, 200);

    mockProvider.generateChatResponse = originalGen;
    console.log("✓ Test 14 Passed: Concurrent generation rejected with 409 GENERATION_IN_PROGRESS and lock released cleanly");

    console.log("\n=============================================================");
    console.log("=== ALL EDIT & REGENERATE TESTS PASSED SUCCESSFULLY (14/14) =");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (conversationAId) {
        await Message.deleteMany({ conversationId: conversationAId });
        await Conversation.findByIdAndDelete(conversationAId);
      }
      if (userAId) {
        await User.findByIdAndDelete(userAId);
        await TokenBalance.deleteOne({ userId: userAId });
      }
      if (userBId) {
        await User.findByIdAndDelete(userBId);
        await TokenBalance.deleteOne({ userId: userBId });
      }
    } catch {}
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Edit & Regenerate Test Suite Failed:", err);
  process.exit(1);
});
