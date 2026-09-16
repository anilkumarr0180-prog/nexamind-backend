import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as tokenRepository from "../src/modules/tokens/token.repository.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { AppError } from "../src/errors/app.error.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class ControllableMockProvider implements AIProvider {
  public readonly name = "mock-credit-failure-ai";
  public callCount = 0;
  public failMode: "none" | "throw_error" | "throw_timeout" = "none";
  public lastPrompt: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-credit-failure-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.lastPrompt = messages;

    if (this.failMode === "throw_error") {
      throw new Error("Simulated upstream provider outage");
    }

    if (this.failMode === "throw_timeout") {
      throw new AppError("AI provider request timed out", 504, "AI_PROVIDER_TIMEOUT");
    }

    return {
      content: "Response from reliable mock provider.",
      provider: "mock-credit-failure-ai",
      model: "mock-model",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    };
  }
}

const runTestSuite = async () => {
  console.log("===============================================================");
  console.log("=== Starting F02 Credit Failure Semantics Comprehensive Tests ==");
  console.log("===============================================================");

  await connectDatabase();

  const mockProvider = new ControllableMockProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testId = Date.now();
  const userEmail = `credit_test_${testId}@example.com`;
  const password = "Password123!@#$";

  let userId = "";
  let authToken = "";
  let conversationId = "";

  try {
    // 1. Setup User and Conversation
    const reg = await authService.register({ email: userEmail, password });
    userId = reg.user.id;
    authToken = reg.accessToken;

    const conv = await conversationService.createConversation(userId, {
      title: "Credit Failure Semantics Test Conversation",
    });
    conversationId = conv._id.toString();

    const initialTokenData = await tokenService.getBalance(userId);
    assert.equal(initialTokenData.balance, 100, "Initial credit balance must be 100");
    console.log(`✓ User initialized with balance: ${initialTokenData.balance}`);

    // -------------------------------------------------------------------------
    // TEST 1: Normal Successful Chat Flow
    // Invariant: deduct 1, provider succeeds, assistant msg created, credit deducted
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Successful AI Chat Request: credit deducted & messages persisted...");
    mockProvider.failMode = "none";
    const initialCallCount = mockProvider.callCount;

    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Hello AI, please assist me.",
      }),
    });

    assert.equal(res1.status, 200, "Successful request must return HTTP 200");
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.data.assistantMessage.content, "Response from reliable mock provider.");

    // Balance verification: must be 99
    const balanceAfterSuccess = (await tokenService.getBalance(userId)).balance;
    assert.equal(balanceAfterSuccess, 99, "Balance must be exactly 99 after 1 credit deduction");

    // Database verification: User message COMPLETED, Assistant message COMPLETED
    const messages1 = await Message.find({ conversationId }).sort({ createdAt: 1 });
    assert.equal(messages1.length, 2, "There must be exactly 2 messages in the conversation");
    assert.equal(messages1[0]?.role, MESSAGE_ROLES.USER);
    assert.equal(messages1[0]?.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(messages1[1]?.role, MESSAGE_ROLES.ASSISTANT);
    assert.equal(messages1[1]?.status, MESSAGE_STATUSES.COMPLETED);
    assert.equal(mockProvider.callCount, initialCallCount + 1, "Provider should be called once");
    console.log("✓ Test 1 Passed: 1 credit deducted, 2 messages created with COMPLETED status");

    // -------------------------------------------------------------------------
    // TEST 2: Provider Failure (502)
    // Invariant: deduct 1, provider fails, refund 1, user message FAILED, 0 assistant msg
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Provider Failure (502): credit refunded & user message marked FAILED...");
    mockProvider.failMode = "throw_error";
    const balanceBeforeFail = (await tokenService.getBalance(userId)).balance;
    const assistantCountBeforeFail = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });

    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "This request will trigger provider error.",
      }),
    });

    assert.equal(res2.status, 502, "Provider failure must return HTTP 502");
    const json2 = await res2.json();
    assert.equal(json2.error.code, "AI_PROVIDER_ERROR");

    // Balance verification: must remain 99 (deducted 1, then refunded 1)
    const balanceAfterFail = (await tokenService.getBalance(userId)).balance;
    assert.equal(
      balanceAfterFail,
      balanceBeforeFail,
      `Balance must be refunded to ${balanceBeforeFail} upon provider failure`,
    );

    // Database verification: latest user message marked FAILED, no assistant message added
    const userMessagesAfterFail = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.USER,
    }).sort({ createdAt: 1 });
    const latestUserMsg = userMessagesAfterFail[userMessagesAfterFail.length - 1];
    assert.equal(latestUserMsg?.status, MESSAGE_STATUSES.FAILED, "User message status must be FAILED");

    const assistantCountAfterFail = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });
    assert.equal(
      assistantCountAfterFail,
      assistantCountBeforeFail,
      "No assistant message must be created on provider failure",
    );
    console.log("✓ Test 2 Passed: 1 credit refunded, user message marked FAILED, 0 assistant message created");

    // -------------------------------------------------------------------------
    // TEST 3: Provider Timeout (504)
    // Invariant: F05 timeout triggers credit refund, user message FAILED, no assistant msg
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Provider Timeout (504): credit refunded & user message marked FAILED...");
    mockProvider.failMode = "throw_timeout";
    const balanceBeforeTimeout = (await tokenService.getBalance(userId)).balance;
    const assistantCountBeforeTimeout = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });

    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "This request will trigger provider timeout.",
      }),
    });

    assert.equal(res3.status, 504, "Provider timeout must return HTTP 504");
    const json3 = await res3.json();
    assert.equal(json3.error.code, "AI_PROVIDER_TIMEOUT");

    const balanceAfterTimeout = (await tokenService.getBalance(userId)).balance;
    assert.equal(
      balanceAfterTimeout,
      balanceBeforeTimeout,
      "Balance must be refunded upon provider timeout",
    );

    const userMessagesAfterTimeout = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.USER,
    }).sort({ createdAt: 1 });
    const latestUserMsgTimeout = userMessagesAfterTimeout[userMessagesAfterTimeout.length - 1];
    assert.equal(latestUserMsgTimeout?.status, MESSAGE_STATUSES.FAILED, "User message status must be FAILED");

    const assistantCountAfterTimeout = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });
    assert.equal(assistantCountAfterTimeout, assistantCountBeforeTimeout, "No assistant message on timeout");
    console.log("✓ Test 3 Passed: Timeout triggers refund, user message marked FAILED, no assistant message");

    // -------------------------------------------------------------------------
    // TEST 4: Assistant Message Persistence Failure (Step 8)
    // Invariant: Provider succeeded, but persisting assistant message throws -> credit refunded, user msg FAILED
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Assistant Message Persistence Failure: credit refunded & user message marked FAILED...");
    mockProvider.failMode = "none";
    const balanceBeforeStep8 = (await tokenService.getBalance(userId)).balance;
    const assistantCountBeforeStep8 = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });

    // Intercept Message.create for assistant message
    const originalCreate = Message.create.bind(Message);
    (Message as any).create = async function (data: any, ...rest: any[]) {
      if (data && data.role === MESSAGE_ROLES.ASSISTANT) {
        throw new Error("Simulated database crash while persisting ASSISTANT message");
      }
      return originalCreate(data, ...rest);
    };

    let res4: Response | null = null;
    try {
      res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Testing assistant persistence failure compensation.",
        }),
      });
    } finally {
      // Restore Message.create
      (Message as any).create = originalCreate;
    }

    assert.ok(res4);
    assert.equal(res4.status, 502, "Assistant persistence failure must return 502");
    const json4 = await res4.json();
    assert.equal(json4.error.code, "AI_PROVIDER_ERROR");

    const balanceAfterStep8 = (await tokenService.getBalance(userId)).balance;
    assert.equal(
      balanceAfterStep8,
      balanceBeforeStep8,
      "Credit must be refunded if assistant message persistence fails",
    );

    const userMsgsAfterStep8 = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.USER,
    }).sort({ createdAt: 1 });
    const latestUserMsgStep8 = userMsgsAfterStep8[userMsgsAfterStep8.length - 1];
    assert.equal(latestUserMsgStep8?.status, MESSAGE_STATUSES.FAILED, "User message must be marked FAILED");

    const assistantCountAfterStep8 = await Message.countDocuments({
      conversationId,
      role: MESSAGE_ROLES.ASSISTANT,
    });
    assert.equal(assistantCountAfterStep8, assistantCountBeforeStep8, "No assistant message should exist");
    console.log("✓ Test 4 Passed: Assistant persistence error compensated with refund & user msg FAILED");

    // -------------------------------------------------------------------------
    // TEST 5: Context Retrieval Failure (Step 6)
    // Invariant: User message persisted, but context query fails -> credit refunded, user msg FAILED, provider not called
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Context Retrieval Failure: credit refunded & provider never invoked...");
    mockProvider.failMode = "none";
    const providerCountBeforeStep6 = mockProvider.callCount;
    const balanceBeforeStep6 = (await tokenService.getBalance(userId)).balance;

    const originalFind = Message.find.bind(Message);
    (Message as any).find = function (filter: any, ...rest: any[]) {
      if (filter && filter.conversationId) {
        return {
          sort: () => {
            throw new Error("Simulated query timeout during context retrieval");
          },
        };
      }
      return originalFind(filter, ...rest);
    };

    let res5: Response | null = null;
    try {
      res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Testing context lookup failure compensation.",
        }),
      });
    } finally {
      (Message as any).find = originalFind;
    }

    assert.ok(res5);
    assert.equal(res5.status, 502, "Context retrieval failure must return 502");

    const balanceAfterStep6 = (await tokenService.getBalance(userId)).balance;
    assert.equal(balanceAfterStep6, balanceBeforeStep6, "Credit must be refunded if context lookup fails");
    assert.equal(mockProvider.callCount, providerCountBeforeStep6, "Provider must NOT have been called");

    const userMsgsAfterStep6 = await Message.find({
      conversationId,
      role: MESSAGE_ROLES.USER,
    }).sort({ createdAt: 1 });
    const latestUserMsgStep6 = userMsgsAfterStep6[userMsgsAfterStep6.length - 1];
    assert.equal(latestUserMsgStep6?.status, MESSAGE_STATUSES.FAILED, "User message must be marked FAILED");
    console.log("✓ Test 5 Passed: Context lookup failure compensated with refund & provider not called");

    // -------------------------------------------------------------------------
    // TEST 6: User Message Persistence Failure (Step 5)
    // Invariant: Credit deducted, but user message save throws -> credit refunded, safe null handling
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] User Message Persistence Failure: credit refunded safely...");
    mockProvider.failMode = "none";
    const balanceBeforeStep5 = (await tokenService.getBalance(userId)).balance;

    const originalCreateStep5 = Message.create.bind(Message);
    (Message as any).create = async function (data: any, ...rest: any[]) {
      if (data && data.role === MESSAGE_ROLES.USER) {
        throw new Error("Simulated database failure during user message creation");
      }
      return originalCreateStep5(data, ...rest);
    };

    let res6: Response | null = null;
    try {
      res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Testing user message insert failure compensation.",
        }),
      });
    } finally {
      (Message as any).create = originalCreateStep5;
    }

    assert.ok(res6);
    assert.equal(res6.status, 502, "User message persistence failure returns 502");

    const balanceAfterStep5 = (await tokenService.getBalance(userId)).balance;
    assert.equal(balanceAfterStep5, balanceBeforeStep5, "Credit must be refunded even if user message insert fails");
    console.log("✓ Test 6 Passed: User message insert failure refunded cleanly without unhandled exceptions");

    // -------------------------------------------------------------------------
    // TEST 7: Insufficient Credits Pre-Check
    // Invariant: Zero balance returns 402, balance stays 0, provider never invoked
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Insufficient Credits: 402 INSUFFICIENT_CREDITS, balance unchanged...");
    const currentBalanceToDrain = (await tokenService.getBalance(userId)).balance;
    await tokenService.deductCredits(userId, currentBalanceToDrain);

    const drainedBalance = (await tokenService.getBalance(userId)).balance;
    assert.equal(drainedBalance, 0, "Balance must now be 0");

    const providerCallsBefore402 = mockProvider.callCount;

    const res7 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId,
        content: "Will I chat with 0 credits?",
      }),
    });

    assert.equal(res7.status, 402, "Must return HTTP 402 for insufficient credits");
    const json7 = await res7.json();
    assert.equal(json7.error.code, "INSUFFICIENT_CREDITS");

    const balanceAfter402 = (await tokenService.getBalance(userId)).balance;
    assert.equal(balanceAfter402, 0, "Balance must remain strictly 0");
    assert.equal(mockProvider.callCount, providerCallsBefore402, "Provider must NOT be called");
    console.log("✓ Test 7 Passed: Rejected with 402, balance remained 0, provider not called");

    // -------------------------------------------------------------------------
    // TEST 8: Concurrency Race Condition Safety (Prevent Negative Balance)
    // Invariant: With balance = 1, two simultaneous requests must yield exactly 1 success and 1 failure (402).
    // Balance must NEVER drop to -1.
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Concurrency Race Condition Safety: balance = 1 with 2 concurrent requests...");
    // Refund exactly 1 credit so balance is exactly 1
    await tokenService.refundCredits(userId, 1);
    const balanceExact1 = (await tokenService.getBalance(userId)).balance;
    assert.equal(balanceExact1, 1, "Balance must be exactly 1");

    mockProvider.failMode = "none";

    // Launch two simultaneous requests concurrently
    const [concurrentResA, concurrentResB] = await Promise.all([
      fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Concurrent Request A",
        }),
      }),
      fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Concurrent Request B",
        }),
      }),
    ]);

    const statuses = [concurrentResA.status, concurrentResB.status].sort();
    assert.deepEqual(
      statuses,
      [200, 402],
      "Exactly one request must succeed (200) and one must be rejected (402)",
    );

    const finalConcurrentBalance = (await tokenService.getBalance(userId)).balance;
    assert.equal(
      finalConcurrentBalance,
      0,
      "Final balance must be exactly 0 (never negative -1)",
    );
    console.log("✓ Test 8 Passed: Concurrency check passed; exactly 1 succeeded, 1 rejected with 402, balance is 0 (never negative)");

    // -------------------------------------------------------------------------
    // TEST 9: Atomic Repository Invariant Verification
    // Invariant: atomicDeductBalance with $gte prevents over-deduction
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Direct Token Repository Invariant Verification...");
    // Current balance is 0. Attempting to deduct 1 must return null
    const deductResult = await tokenRepository.atomicDeductBalance(userId, 1);
    assert.equal(deductResult, null, "Deducting from 0 balance must return null");

    const checkBalanceStill0 = await tokenRepository.findTokenBalanceByUserId(userId);
    assert.equal(checkBalanceStill0?.balance, 0, "Balance must remain 0");

    // Add 5 credits atomically
    const addResult = await tokenRepository.atomicAddBalance(userId, 5);
    assert.equal(addResult?.balance, 5, "Adding 5 credits must result in balance 5");

    // Attempting to deduct 10 must return null
    const overDeductResult = await tokenRepository.atomicDeductBalance(userId, 10);
    assert.equal(overDeductResult, null, "Over-deduction must return null without modifying balance");

    const checkBalanceStill5 = await tokenRepository.findTokenBalanceByUserId(userId);
    assert.equal(checkBalanceStill5?.balance, 5, "Balance must remain strictly 5");

    // Deduct exact amount (5)
    const exactDeductResult = await tokenRepository.atomicDeductBalance(userId, 5);
    assert.equal(exactDeductResult?.balance, 0, "Exact deduction must succeed and result in balance 0");
    console.log("✓ Test 9 Passed: Atomic repository guarantees $gte check, atomic increment/decrement, and prevents negative balances");

    console.log("\n===============================================================");
    console.log("=== ALL F02 CREDIT FAILURE SEMANTICS TESTS PASSED (9/9) =======");
    console.log("===============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (userId) {
      await User.deleteOne({ _id: userId });
      await TokenBalance.deleteOne({ userId });
    }
    if (conversationId) {
      await Conversation.deleteOne({ _id: conversationId });
      await Message.deleteMany({ conversationId });
    }
    await disconnectDatabase();
  }
};

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
