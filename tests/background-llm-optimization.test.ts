import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose, { Types } from "mongoose";
import app from "../src/app.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { CreditTransaction } from "../src/modules/credit-transactions/credit-transaction.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as conversationContinuityService from "../src/modules/conversations/conversation-continuity.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { resolveDedicatedTestDbUri } from "../load-tests/config.ts";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class InstrumentedMockAIProvider implements AIProvider {
  public readonly name = "instrumented-mock-provider";
  public totalCalls = 0;
  public chatCalls = 0;
  public extractionCalls = 0;
  public summarizationCalls = 0;
  public nextExtractionResponse: string | null = null;
  public lastCapturedMessages: AIMessage[] = [];
  public lastCapturedChatMessages: AIMessage[] = [];

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    this.totalCalls++;
    this.lastCapturedMessages = JSON.parse(JSON.stringify(messages));

    const systemPrompt = messages.find((m) => m.role === "system")?.content || "";

    if (systemPrompt.includes("memory extraction system")) {
      this.extractionCalls++;
      return {
        content: this.nextExtractionResponse ?? JSON.stringify({ memories: [] }),
        provider: this.name,
        model: "mock-extraction-model",
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      };
    }

    if (systemPrompt.includes("conversation summarization") || systemPrompt.includes("conversation summary") || systemPrompt.includes("summarize")) {
      this.summarizationCalls++;
      return {
        content: "Generated summary of conversation.",
        provider: this.name,
        model: "mock-summary-model",
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      };
    }

    this.chatCalls++;
    this.lastCapturedChatMessages = JSON.parse(JSON.stringify(messages));
    return {
      content: `AI response to user query (chatCall #${this.chatCalls})`,
      provider: this.name,
      model: "mock-chat-model",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.totalCalls++;
    this.chatCalls++;
    this.lastCapturedMessages = JSON.parse(JSON.stringify(messages));
    this.lastCapturedChatMessages = JSON.parse(JSON.stringify(messages));

    const chunks = ["Hello! ", "I am your ", "AI assistant."];
    for (const chunk of chunks) {
      if (signal?.aborted) break;
      yield { content: chunk };
    }
  }

  resetCounts(): void {
    this.totalCalls = 0;
    this.chatCalls = 0;
    this.extractionCalls = 0;
    this.summarizationCalls = 0;
  }
}

const createdUserIds: string[] = [];

async function runBackgroundLlmOptimizationTests(): Promise<void> {
  console.log("\n==========================================================================");
  console.log("=== NEXAMIND BACKGROUND LLM CALL OPTIMIZATION TEST SUITE ===");
  console.log("==========================================================================");

  const testDbUri = resolveDedicatedTestDbUri();
  console.log(`[Setup] Connecting to isolated test database: ${testDbUri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@")}`);

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(testDbUri);
  }

  const mockProvider = new InstrumentedMockAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Setup] Test server running at ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // Setup Test User
    // -------------------------------------------------------------
    const timestamp = Date.now();
    const userEmail = `bg_opt_${timestamp}@test.local`;
    const regResult = await authService.register({
      email: userEmail,
      password: "Password123!@#$",
    });
    const userId = regResult.user.id;
    const authToken = regResult.accessToken;
    createdUserIds.push(userId);

    const conv = await conversationService.createConversation(userId, {
      title: "Background LLM Optimization Conversation",
    });
    const convId = conv._id.toString();

    // -------------------------------------------------------------------------
    // TEST 1: TRIVIAL MESSAGES SKIP MEMORY EXTRACTION LLM CALLS
    // Greetings, acknowledgments, and very short inputs must NOT call the extraction LLM
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1: TRIVIAL MESSAGES] Verifying extraction is SKIPPED for trivial inputs...");
    console.log("--------------------------------------------------------------------------");

    const trivialMessages = [
      "Hi",
      "Hello!",
      "Hey there",
      "Good morning",
      "Thanks",
      "Thank you so much!",
      "Got it, thanks",
      "Ok",
      "Okay cool",
      "sounds good",
      "k",
      "bye",
    ];

    for (const msg of trivialMessages) {
      const trivialConv = await conversationService.createConversation(userId, {
        title: `Trivial Check: ${msg}`,
      });
      mockProvider.resetCounts();
      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          conversationId: trivialConv._id.toString(),
          content: msg,
        }),
      });

      assert.equal(res.status, 200, `Chat request for "${msg}" should succeed with 200`);
      
      // Wait briefly for any potential async fire-and-forget extraction
      await new Promise((r) => setTimeout(r, 60));

      assert.equal(
        mockProvider.extractionCalls,
        0,
        `Extraction LLM should NOT be called for trivial message: "${msg}" (got ${mockProvider.extractionCalls} calls)`
      );
      assert.equal(
        mockProvider.chatCalls,
        1,
        `Chat LLM should be called exactly once for "${msg}"`
      );
    }

    console.log(`✓ Test 1 Passed: Successfully verified 0 extraction LLM calls across all ${trivialMessages.length} trivial messages.\n`);

    // -------------------------------------------------------------------------
    // TEST 2: MEANINGFUL MESSAGES TRIGGER MEMORY EXTRACTION
    // Meaningful inputs with persistent facts/preferences MUST call extraction LLM
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 2: MEANINGFUL MESSAGES] Verifying extraction IS TRIGGERED for meaningful inputs...");
    console.log("--------------------------------------------------------------------------");

    mockProvider.resetCounts();
    mockProvider.nextExtractionResponse = JSON.stringify({
      memories: [
        {
          type: "FACT",
          content: "User is a cloud architect specializing in Kubernetes clusters",
        },
      ],
    });

    const meaningfulConv = await conversationService.createConversation(userId, {
      title: "Meaningful Architecture Conv",
    });
    const meaningfulMessage = "I am a cloud architect specializing in Kubernetes clusters.";

    const resMeaningful = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId: meaningfulConv._id.toString(),
        content: meaningfulMessage,
      }),
    });

    assert.equal(resMeaningful.status, 200);

    // Wait for async extraction completion
    let extractedMem = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
      extractedMem = await Memory.findOne({
        userId: new Types.ObjectId(userId),
        content: "User is a cloud architect specializing in Kubernetes clusters",
      });
      if (extractedMem) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(extractedMem, "Meaningful message must successfully extract and persist memory");
    assert.equal(mockProvider.chatCalls, 1, "Chat LLM called once");
    assert.equal(mockProvider.extractionCalls, 1, "Extraction LLM called once for meaningful input");

    console.log("✓ Test 2 Passed: Meaningful message triggered extraction LLM call (1/1) and persisted memory.\n");

    // -------------------------------------------------------------------------
    // TEST 3: CONTEXT BUILDING DOES NOT WAIT FOR ON-DEMAND LLM SUMMARIZATION
    // Previous conversation has messages but NO summary in database.
    // Querying continuity context must NOT synchronously trigger an LLM summarization call.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 3: CONTEXT BUILDING] Verifying NO synchronous LLM summarization on hot path...");
    console.log("--------------------------------------------------------------------------");

    // Create a previous unsummarized conversation with 4 completed messages
    const prevConv = await Conversation.create({
      userId: new Types.ObjectId(userId),
      title: "Previous Unsummarized Project",
      status: "ACTIVE",
      messageCount: 4,
      summary: null, // No summary stored
    });

    await Message.create({
      conversationId: prevConv._id,
      userId: new Types.ObjectId(userId),
      role: MESSAGE_ROLES.USER,
      content: "We should migrate our database to MongoDB Atlas replica set.",
      status: MESSAGE_STATUSES.COMPLETED,
    });
    await Message.create({
      conversationId: prevConv._id,
      userId: new Types.ObjectId(userId),
      role: MESSAGE_ROLES.ASSISTANT,
      content: "MongoDB Atlas replica sets provide high availability and automated failover.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // Now in a fresh conversation, user asks a continuity question
    const continuityConv = await conversationService.createConversation(userId, {
      title: "Continuity Check Conversation",
    });

    mockProvider.resetCounts();

    const continuityQuery = "What were we talking about earlier regarding databases?";

    // Direct check: Context builder retrieval makes 0 LLM calls for unsummarized conversations
    const unsummarizedCtx = await conversationContinuityService.getContinuityContextForUser({
      userId,
      currentConversationId: continuityConv._id,
      userQuery: continuityQuery,
      customProvider: mockProvider,
    });
    assert.equal(unsummarizedCtx, null, "Unsummarized candidates cleanly fail-open without blocking");
    assert.equal(mockProvider.summarizationCalls, 0, "No on-demand summarization calls made during context building");

    // End-to-end check: Chat proceeds without blocking on summarization
    mockProvider.resetCounts();
    const resContinuity = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId: continuityConv._id.toString(),
        content: continuityQuery,
      }),
    });

    assert.equal(resContinuity.status, 200, "Continuity chat must succeed fail-open");
    assert.equal(mockProvider.chatCalls, 1, "Main chat response LLM was called exactly once");

    console.log("✓ Test 3 Passed: Hot path context building completed with exactly 0 synchronous summarization LLM calls.\n");

    // -------------------------------------------------------------------------
    // TEST 4: EXISTING PERSISTED SUMMARIES REMAIN RETRIEVABLE & USABLE
    // When a conversation HAS a persisted summary, continuity context retrieves it without extra LLM calls.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 4: EXISTING SUMMARIES] Verifying cached summaries are reused without LLM calls...");
    console.log("--------------------------------------------------------------------------");

    const documentedConv = await Conversation.create({
      userId: new Types.ObjectId(userId),
      title: "Documented Architecture Conversation",
      status: "ACTIVE",
      messageCount: 8,
      summary: "User established a multi-region deployment on Google Cloud with Cloud Run and MongoDB Atlas.",
      summaryUpdatedAt: new Date(),
    });

    const activeContinuityConv = await conversationService.createConversation(userId, {
      title: "Active Continuity Conversation",
    });

    mockProvider.resetCounts();

    const resumeQuery = "In our previous conversation, what did we decide about Google Cloud deployment?";

    // Direct check: Cached summary retrieval makes exactly 0 LLM calls
    const cachedCtx = await conversationContinuityService.getContinuityContextForUser({
      userId,
      currentConversationId: activeContinuityConv._id,
      userQuery: resumeQuery,
      customProvider: mockProvider,
    });
    assert.ok(cachedCtx?.includes("multi-region deployment on Google Cloud"), "Cached summary must be retrieved");
    assert.equal(mockProvider.summarizationCalls, 0, "Cached summary retrieval must NOT call the summarization LLM");
    assert.equal(mockProvider.totalCalls, 0, "No LLM calls during cached summary retrieval");

    // End-to-end check: Cached summary is injected into chat context
    mockProvider.resetCounts();
    const resResume = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId: activeContinuityConv._id.toString(),
        content: resumeQuery,
      }),
    });

    assert.equal(resResume.status, 200);

    // Verify context builder injected the cached summary into the AI chat messages
    const allCapturedText = mockProvider.lastCapturedChatMessages.map((m) => m.content).join("\n");
    assert.ok(
      allCapturedText.includes("multi-region deployment on Google Cloud"),
      "Persisted summary must be present in AI context"
    );

    console.log("✓ Test 4 Passed: Cached conversation summary successfully injected into prompt with 0 LLM summarization calls.\n");

    // -------------------------------------------------------------------------
    // TEST 5: STREAMING CHAT ISOLATION & FAIL-OPEN RESILIENCE
    // Trivial messages in streaming chat also skip extraction, and failures never break chat
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 5: STREAMING RESILIENCE] Streaming chat skips extraction for trivial messages...");
    console.log("--------------------------------------------------------------------------");

    mockProvider.resetCounts();

    const resStream = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId: activeContinuityConv._id.toString(),
        content: "Thank you!",
        stream: true,
      }),
    });

    assert.equal(resStream.status, 200);
    assert.ok(resStream.headers.get("content-type")?.includes("text/event-stream"));

    await new Promise((r) => setTimeout(r, 80));

    assert.equal(
      mockProvider.extractionCalls,
      0,
      "Streaming chat for 'Thank you!' must NOT trigger extraction LLM"
    );

    console.log("✓ Test 5 Passed: Streaming chat verified; trivial messages skip extraction cleanly.\n");

    // -------------------------------------------------------------------------
    // TEST 6: FAIL-OPEN RESILIENCE ON BACKGROUND / CONTINUITY FAILURES
    // Even if memory extraction or candidate lookup throws, chat succeeds with 200
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 6: FAIL-OPEN RESILIENCE] Chat succeeds even when background services error...");
    console.log("--------------------------------------------------------------------------");

    const failOpenConv = await conversationService.createConversation(userId, {
      title: "Fail-Open Resilience Check",
    });

    // Mock extraction failure for this turn
    mockProvider.nextExtractionResponse = "INVALID_NON_JSON_CORRUPTED_RESPONSE";

    const resFailOpen = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        conversationId: failOpenConv._id.toString(),
        content: "I am configuring a distributed Redis cache cluster.",
      }),
    });

    assert.equal(resFailOpen.status, 200, "Chat must return 200 despite extraction parsing errors");
    const jsonFailOpen = await resFailOpen.json();
    assert.ok(jsonFailOpen.data?.assistantMessage?.content, "Chat response assistant message content must be returned");

    console.log("✓ Test 6 Passed: Fail-open resilience verified; background errors do not break chat.\n");

    console.log("==========================================================================");
    console.log("=== ALL 6 BACKGROUND LLM OPTIMIZATION TESTS PASSED (6/6) ===");
    console.log("==========================================================================\n");
  } finally {
    await new Promise((r) => setTimeout(r, 200));
    server.close();
    if (createdUserIds.length > 0) {
      const oids = createdUserIds.map((id) => new Types.ObjectId(id));
      await Promise.all([
        User.deleteMany({ _id: { $in: oids } }),
        Conversation.deleteMany({ userId: { $in: oids } }),
        Message.deleteMany({ userId: { $in: oids } }),
        Memory.deleteMany({ userId: { $in: oids } }),
        TokenBalance.deleteMany({ userId: { $in: oids } }),
        CreditTransaction.deleteMany({ userId: { $in: oids } }),
      ]);
    }
    await mongoose.disconnect();
  }
}

runBackgroundLlmOptimizationTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
