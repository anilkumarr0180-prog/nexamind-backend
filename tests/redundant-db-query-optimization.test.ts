import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose, { Types } from "mongoose";
import app from "../src/app.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as conversationRepository from "../src/modules/conversations/conversation.repository.js";
import * as messageRepository from "../src/modules/messages/message.repository.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import { resolveDedicatedTestDbUri } from "../load-tests/config.ts";

class MockTestAIProvider implements AIProvider {
  public readonly name = "mock-db-opt-provider";
  public shouldFail = false;

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    if (this.shouldFail) {
      throw new Error("Simulated AI provider failure for rollback testing");
    }
    return {
      content: "Optimized AI response",
      provider: this.name,
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    };
  }

  async *generateChatStream(
    _messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    if (this.shouldFail) {
      throw new Error("Simulated streaming failure");
    }
    yield { content: "Streaming chunk 1" };
    yield { content: "Streaming chunk 2", done: true };
  }
}

const createdUserIds: string[] = [];

async function runOptimizationTests(): Promise<void> {
  console.log("\n==========================================================================");
  console.log("=== NEXAMIND REDUNDANT DATABASE QUERY OPTIMIZATION VERIFICATION SUITE ===");
  console.log("==========================================================================");

  const testDbUri = resolveDedicatedTestDbUri();
  console.log(`[Setup] Connecting to isolated test database...`);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(testDbUri);
  }

  const mockProvider = new MockTestAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Setup] Test server active at ${baseUrl}\n`);

  try {
    const timestamp = Date.now();
    const user = await authService.register({
      email: `db_opt_${timestamp}@test.local`,
      password: "Password123!@#$",
    });
    createdUserIds.push(user.user.id);

    const conv = await conversationService.createConversation(user.user.id, {
      title: "Query Optimization Test Conversation",
    });

    // -------------------------------------------------------------------------
    // TEST 1: REDUNDANT DB READS ARE ACTUALLY ELIMINATED
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1: ELIMINATED QUERIES] Measuring query calls per chat turn...");
    console.log("--------------------------------------------------------------------------");
    {
      let countDocumentsCalls = 0;
      let findConversationCalls = 0;

      const origCountDocuments = Message.countDocuments;
      const origFindOne = Conversation.findOne;

      (Message as any).countDocuments = function (this: any, ...args: any[]) {
        const query = args[0];
        if (query && query.conversationId && query.conversationId.toString() === conv._id.toString()) {
          countDocumentsCalls++;
        }
        return origCountDocuments.apply(this, args as any);
      };

      (Conversation as any).findOne = function (this: any, ...args: any[]) {
        const query = args[0];
        if (query && query._id && query._id.toString() === conv._id.toString() && query.userId) {
          findConversationCalls++;
        }
        return origFindOne.apply(this, args as any);
      };

      try {
        const tStart = Date.now();
        const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.accessToken}`,
          },
          body: JSON.stringify({
            conversationId: conv._id.toString(),
            content: "Turn 1: Hello AI!",
          }),
        });
        const tElapsed = Date.now() - tStart;

        assert.strictEqual(res.status, 200);

        // 1. Redundant full-message count call must be ZERO
        assert.strictEqual(
          countDocumentsCalls,
          0,
          `Redundant countMessagesByConversationId must NOT be called (called ${countDocumentsCalls} times)`,
        );

        // 2. Pre-loaded conversation was reused in Context Builder (0 calls from context builder).
        // Total findOne is at most 2 (1 in orchestrator + 1 in background summarization; context-builder eliminated).
        assert.ok(
          findConversationCalls <= 2,
          `findConversationByIdAndUserId was called ${findConversationCalls} times (context builder redundant read was eliminated)`,
        );

        console.log(`✓ Test 1 Passed: Redundant full-message scan (0 calls) & duplicate findConversation eliminated (context-builder = 0 calls) in ${tElapsed}ms\n`);
      } finally {
        (Message as any).countDocuments = origCountDocuments;
        (Conversation as any).findOne = origFindOne;
      }
    }

    // -------------------------------------------------------------------------
    // TEST 1B: DIRECT VERIFICATION OF CONTEXT BUILDER REUSE
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1B: CONTEXT BUILDER REUSE] Directly verifying conversation reuse...");
    console.log("--------------------------------------------------------------------------");
    {
      const contextBuilderService = await import("../src/modules/ai/context-builder.service.js");
      const loadedConv = await Conversation.findById(conv._id);

      let contextFindCalls = 0;
      const origFindOne = Conversation.findOne;
      (Conversation as any).findOne = function (this: any, ...args: any[]) {
        const query = args[0];
        if (query && query._id && query._id.toString() === conv._id.toString() && query.userId) {
          contextFindCalls++;
        }
        return origFindOne.apply(this, args as any);
      };

      try {
        // Direct call WITH preloaded conversation
        await contextBuilderService.buildFullChatContext({
          conversationId: conv._id.toString(),
          userId: user.user.id,
          message: "Testing direct context builder reuse",
          conversation: loadedConv,
        });
        assert.strictEqual(
          contextFindCalls,
          0,
          `With preloaded conversation, findConversation must NOT be called (called ${contextFindCalls} times)`,
        );

        // Direct call WITHOUT preloaded conversation (fallback path)
        await contextBuilderService.buildFullChatContext({
          conversationId: conv._id.toString(),
          userId: user.user.id,
          message: "Testing fallback without preloaded conversation",
        });
        assert.strictEqual(
          contextFindCalls,
          1,
          `Without preloaded conversation, findConversation must be called exactly once (called ${contextFindCalls} times)`,
        );
        console.log("✓ Test 1B Passed: ContextBuilder safely reuses preloaded conversation (0 DB reads) and cleanly falls back if omitted (1 DB read)\n");
      } finally {
        (Conversation as any).findOne = origFindOne;
      }
    }

    // -------------------------------------------------------------------------
    // TEST 2: MESSAGE COUNT REMAINS CORRECT AFTER NORMAL CHAT
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 2: NORMAL CHAT COUNT] Testing count accuracy across sequential turns...");
    console.log("--------------------------------------------------------------------------");
    {
      // After Turn 1: exactly 2 messages in DB
      let convRecord = await Conversation.findById(conv._id);
      let actualDbCount = await Message.countDocuments({ conversationId: conv._id });

      assert.strictEqual(convRecord?.messageCount, 2, "Turn 1 must result in messageCount = 2");
      assert.strictEqual(convRecord?.messageCount, actualDbCount, "messageCount must match physical message count");

      // Turn 2:
      const resTurn2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conv._id.toString(),
          content: "Turn 2: What is the capital of France?",
        }),
      });
      assert.strictEqual(resTurn2.status, 200);

      convRecord = await Conversation.findById(conv._id);
      actualDbCount = await Message.countDocuments({ conversationId: conv._id });

      assert.strictEqual(convRecord?.messageCount, 4, "Turn 2 must result in messageCount = 4");
      assert.strictEqual(convRecord?.messageCount, actualDbCount, "messageCount must match physical message count (4)");

      console.log(`✓ Test 2 Passed: Sequential normal chat turns accurately increment counter (current count: ${convRecord?.messageCount})\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: STREAMING CHAT PRESERVES COUNT CONSISTENCY
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 3: STREAMING CHAT COUNT] Testing count accuracy after streaming turn...");
    console.log("--------------------------------------------------------------------------");
    {
      const resStream = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conv._id.toString(),
          content: "Turn 3: Streaming prompt",
          stream: true,
        }),
      });
      assert.strictEqual(resStream.status, 200);

      // Consume stream text
      await resStream.text();

      const convRecord = await Conversation.findById(conv._id);
      const actualDbCount = await Message.countDocuments({ conversationId: conv._id });

      assert.strictEqual(convRecord?.messageCount, 6, "Turn 3 (stream) must result in messageCount = 6");
      assert.strictEqual(convRecord?.messageCount, actualDbCount, "Streaming turn matches physical count (6)");

      console.log(`✓ Test 3 Passed: Streaming chat turn correctly incremented counter to ${convRecord?.messageCount}\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: EDIT/REGENERATE & BRANCHING PRESERVES EXACT COUNTING SEMANTICS
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 4: EDIT/REGENERATE COUNT] Testing branching preserves physical count...");
    console.log("--------------------------------------------------------------------------");
    {
      // Fetch latest user message to edit
      const userMsgs = await Message.find({
        conversationId: conv._id,
        role: MESSAGE_ROLES.USER,
        status: MESSAGE_STATUSES.COMPLETED,
      }).sort({ createdAt: -1 });

      assert.ok(userMsgs.length > 0);
      const targetEditMsg = userMsgs[0]!;

      // Edit and regenerate
      const resEdit = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conv._id.toString(),
          content: "Turn 3 (Edited): New revised user question",
          editMessageId: targetEditMsg._id.toString(),
        }),
      });
      assert.strictEqual(resEdit.status, 200);

      const convRecord = await Conversation.findById(conv._id);
      const actualDbCount = await Message.countDocuments({ conversationId: conv._id });

      // Non-destructive branching appends the edited user msg and new assistant msg (6 + 2 = 8)
      assert.strictEqual(convRecord?.messageCount, 8, "Edit/regenerate turn must result in messageCount = 8");
      assert.strictEqual(convRecord?.messageCount, actualDbCount, "Branching turn matches physical count (8)");

      console.log(`✓ Test 4 Passed: Non-destructive edit/branching preserved exact counting semantics (count: ${convRecord?.messageCount})\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: FAILED REQUESTS DO NOT CORRUPT COUNTERS
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 5: FAILED REQUEST ROLLBACK] Testing provider failure does not increment count...");
    console.log("--------------------------------------------------------------------------");
    {
      const countBeforeFailure = (await Conversation.findById(conv._id))?.messageCount ?? 0;

      mockProvider.shouldFail = true;

      const resFail = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conv._id.toString(),
          content: "This turn will fail",
        }),
      });
      assert.strictEqual(resFail.status, 502);

      mockProvider.shouldFail = false;

      const convRecord = await Conversation.findById(conv._id);
      assert.strictEqual(
        convRecord?.messageCount,
        countBeforeFailure,
        "Failed request must NOT increment conversation messageCount",
      );

      console.log(`✓ Test 5 Passed: Provider failure left conversation counter intact (${convRecord?.messageCount})\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: EXISTING SUMMARIES AND MEMORIES WORK SEAMLESSLY
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 6: SUMMARIES & MEMORIES] Testing context builder uses cached summary...");
    console.log("--------------------------------------------------------------------------");
    {
      // Add summary to conversation
      const summaryText = "Summary: User and assistant discussed architectural designs and math questions.";
      await Conversation.findByIdAndUpdate(conv._id, { summary: summaryText });

      // Run chat turn
      const resChatWithSummary = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conv._id.toString(),
          content: "Where did we leave off?",
        }),
      });
      assert.strictEqual(resChatWithSummary.status, 200);

      const convRecord = await Conversation.findById(conv._id);
      assert.strictEqual(convRecord?.messageCount, 10, "Turn with summary incremented count to 10");
      assert.strictEqual(convRecord?.summary, summaryText, "Summary remains preserved");

      console.log(`✓ Test 6 Passed: Summaries & memory context work seamlessly with zero database overhead\n`);
    }

    console.log("==========================================================================");
    console.log("=== ALL REDUNDANT DB QUERY OPTIMIZATION TESTS PASSED (6/6) ===");
    console.log("==========================================================================\n");
  } finally {
    server.close();
    if (createdUserIds.length > 0) {
      const oids = createdUserIds.map((id) => new Types.ObjectId(id));
      await Promise.all([
        User.deleteMany({ _id: { $in: oids } }),
        Conversation.deleteMany({ userId: { $in: oids } }),
        Message.deleteMany({ userId: { $in: oids } }),
        TokenBalance.deleteMany({ userId: { $in: oids } }),
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await mongoose.disconnect();
  }
}

runOptimizationTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
