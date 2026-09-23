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
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import {
  isContinuityRequest,
  getContinuityContextForUser,
  MAX_CONTINUITY_SUMMARY_CHARS,
  MAX_CONTINUITY_CONTEXT_CHARS,
} from "../src/modules/conversations/conversation-continuity.service.js";
import { NEXAMIND_CHAT_SYSTEM_PROMPT } from "../src/modules/ai/prompts/system.prompt.js";
import { TestMockEmbeddingProvider } from "./helpers/mock-embedding.helper.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockContinuityAIProvider implements AIProvider {
  public readonly name = "mock-continuity-ai";
  public callCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-continuity-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    }

    this.callCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Mock continuity response #${this.callCount}`,
      provider: "mock-continuity-ai",
      model: "mock-model",
      usage: { inputTokens: 25, outputTokens: 25, totalTokens: 50 },
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
      content: "Streaming continuity response",
      model: "mock-model",
    };

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 25, outputTokens: 25, totalTokens: 50 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Cross-Conversation Continuity Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockContinuityAIProvider();
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
  const userAEmail = `continuity_a_${testTimestamp}@example.com`;
  const userBEmail = `continuity_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";

  try {
    // -------------------------------------------------------------
    // Test 1: Unit Tests for isContinuityRequest
    // -------------------------------------------------------------
    const positiveQueries = [
      "do you remember what we were working on?",
      "where did we stop?",
      "what did we discuss?",
      "continue where we left off",
      "Where did we leave off?",
      "What were we working on?",
      "Remind me where we stopped",
      "Can we continue from where we left off?",
      "Pick up where we left off",
      "What was our last discussion in our previous session?",
      "what did we work on yesterday",
      "what did we discuss last time",
      "what were we working on before",
      "what did we do in our previous session",
      "where did we stop",
      "what was the next step",
      "What did we work on yesterday?",
      "What was the next step?",
      "what were we working on recently",
      "what did we work on lately",
      "what have we been working on",
      "what did we work on recently",
      "what were our recent projects",
      "What were we working on recently?",
      "What did we work on lately?",
      "What have we been working on?",
      "What were our recent projects?",
      "what was the last thing we were working on?",
      "What was the last thing we were working on?",
      "what should we continue?",
      "What should we continue?",
      "what was completed?",
      "What was completed?",
      "what was completed",
      "what should we continue",
      "okay let's continue",
      "Okay, let's continue",
      "ok let's continue",
      "let's continue",
      "lets continue",
      "can we continue",
      "shall we continue",
      "let's resume",
      "continue our previous work",
    ];

    for (const q of positiveQueries) {
      assert.equal(
        isContinuityRequest(q),
        true,
        `Expected query "${q}" to be detected as continuity request`,
      );
    }

    const negativeQueries = [
      "How do I sort an array in TypeScript?",
      "Let us start working on the Beta topic.",
      "Continue with the plan.",
      "Write a unit test for MongoDB connection.",
      "Tell me a programming joke.",
      "What is the capital of France?",
    ];

    for (const q of negativeQueries) {
      assert.equal(
        isContinuityRequest(q),
        false,
        `Expected normal query "${q}" to NOT be detected as continuity request`,
      );
    }
    console.log("✓ Test 1 Passed: Intent detection accurately identifies continuity questions vs normal queries");

    // Setup Users
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    await tokenService.refundCredits(userAId, 100);
    await tokenService.refundCredits(userBId, 100);

    // -------------------------------------------------------------
    // Setup User A Conversations:
    // Conversation 1: Has completed messages and summary
    // -------------------------------------------------------------
    const conv1 = await conversationService.createConversation(userAId, {
      title: "Project Alpha Architecture",
    });
    const conv1Id = conv1._id.toString();

    await Message.create({
      conversationId: conv1Id,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Discussing microservices and authentication.",
      status: MESSAGE_STATUSES.COMPLETED,
    });
    await Message.create({
      conversationId: conv1Id,
      userId: userAId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Designed JWT auth and MongoDB schema.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    const alphaSummary =
      "- What the conversation is about: Project Alpha Architecture\n- What was completed: User Auth and MongoDB schema\n- Where we stopped: Stripe webhook integration\n- Next step: Setup webhook listener and idempotency guard";

    await Conversation.findByIdAndUpdate(conv1Id, {
      messageCount: 2,
      summary: alphaSummary,
      summaryUpdatedAt: new Date(),
      lastSummarizedMessageCount: 2,
    });

    // Conversation 2: Fresh conversation for User A
    const conv2 = await conversationService.createConversation(userAId, {
      title: "New Session Chat",
    });
    const conv2Id = conv2._id.toString();

    // -------------------------------------------------------------
    // Test 2: Continuity Question Retrieves Previous Conversation Summary
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing continuity question retrieves previous conversation summary...");
    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "Do you remember what we were working on?",
      }),
    });

    assert.equal(res2.status, 200, "Must return 200 OK");
    const captured2 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      captured2.content.includes("Previous conversation context:"),
      "Context must include 'Previous conversation context:' header",
    );
    assert.ok(
      captured2.content.includes('Previous conversation "Project Alpha Architecture":'),
      "Context must include title of previous conversation",
    );
    assert.ok(
      captured2.content.includes("Stripe webhook integration"),
      "Context must include summary content from previous conversation",
    );
    assert.ok(
      captured2.content.includes("Setup webhook listener"),
      "Context must include next steps from previous conversation",
    );
    console.log("✓ Test 2 Passed: Previous conversation summary successfully retrieved for continuity question");

    // -------------------------------------------------------------
    // Test 2b: 'What did we work on yesterday?' retrieves previous conversation summary
    // -------------------------------------------------------------
    console.log("\n[Test 2b] Testing 'What did we work on yesterday?' retrieves previous conversation summary...");
    const res2b = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "What did we work on yesterday?",
      }),
    });

    assert.equal(res2b.status, 200, "Must return 200 OK");
    const captured2b = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured2b.content.includes("Previous conversation context:"),
      "Context must include 'Previous conversation context:' header for 'What did we work on yesterday?'",
    );
    assert.ok(
      captured2b.content.includes('Previous conversation "Project Alpha Architecture":'),
      "Context must include title of previous conversation",
    );
    assert.ok(
      captured2b.content.includes("Stripe webhook integration"),
      "Context must include summary content from previous conversation",
    );
    console.log("✓ Test 2b Passed: 'What did we work on yesterday?' successfully retrieved previous conversation summary");

    // -------------------------------------------------------------
    // Test 3: Normal Questions Do NOT Retrieve Previous Conversation Summaries
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing normal questions do NOT retrieve previous conversation summaries...");
    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv2Id,
        content: "How do I implement JWT in Node.js?",
      }),
    });

    assert.equal(res3.status, 200);
    const captured3 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      !captured3.content.includes("Previous conversation context:"),
      "Normal question must NOT contain 'Previous conversation context:'",
    );
    assert.ok(
      !captured3.content.includes("Project Alpha Architecture"),
      "Normal question must NOT contain previous conversation title",
    );
    assert.ok(
      !captured3.content.includes("Stripe webhook integration"),
      "Normal question must NOT contain previous conversation summary",
    );
    console.log("✓ Test 3 Passed: Normal questions strictly isolate and do not retrieve previous conversation summaries");

    // -------------------------------------------------------------
    // Test 4: Current Conversation is Excluded from Continuity Context
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing current conversation is excluded from previous conversation context...");
    // When asking a continuity question in Conversation 1 (which has a summary),
    // Conversation 1 itself must NOT appear under "Previous conversation context:".
    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv1Id,
        content: "Where did we stop?",
      }),
    });

    assert.equal(res4.status, 200);
    const captured4 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    // In Conversation 1, Conversation 1's summary is injected as the active "Conversation summary:"
    assert.ok(
      captured4.content.includes("Conversation summary:"),
      "Active conversation summary must be present",
    );
    // But it must NOT be duplicated under Previous conversation context
    assert.ok(
      !captured4.content.includes('Previous conversation "Project Alpha Architecture":'),
      "Current conversation must NOT be retrieved as a previous conversation",
    );
    console.log("✓ Test 4 Passed: Current conversation is strictly excluded from previous conversation context");

    // -------------------------------------------------------------
    // Test 5: Cross-User Isolation (User B cannot access User A's summaries)
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing cross-user isolation for continuity summaries...");
    const convBUser = await conversationService.createConversation(userBId, {
      title: "User B New Chat",
    });
    const convBUserId = convBUser._id.toString();

    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: convBUserId,
        content: "What did we discuss in our previous session?",
      }),
    });

    assert.equal(res5.status, 200);
    const captured5 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      !captured5.content.includes("Project Alpha Architecture"),
      "User B must not see User A's conversation title",
    );
    assert.ok(
      !captured5.content.includes("Stripe webhook integration"),
      "User B must not see User A's conversation summary",
    );
    assert.ok(
      !captured5.content.includes("Previous conversation context:"),
      "User B has no prior summarized conversations, so header must not appear",
    );
    console.log("✓ Test 5 Passed: Cross-user isolation strictly verified; User B cannot access User A's summaries");

    // -------------------------------------------------------------
    // Test 6: Conversations Without Summaries are Ignored
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing conversations without summaries are ignored...");
    // Create Conversation 3 for User A with messages, but NO summary
    const conv3 = await conversationService.createConversation(userAId, {
      title: "Unsummarized Brainstorming",
    });
    const conv3Id = conv3._id.toString();

    await Message.create({
      conversationId: conv3Id,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Brainstorming raw notes without summarization.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // Create Conversation 4 for User A
    const conv4 = await conversationService.createConversation(userAId, {
      title: "Fourth Conversation",
    });
    const conv4Id = conv4._id.toString();

    const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "Continue where we left off",
      }),
    });

    assert.equal(res6.status, 200);
    const captured6 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    // Must include Conversation 1 (has summary)
    assert.ok(
      captured6.content.includes('Previous conversation "Project Alpha Architecture":'),
      "Must include summarized conversation",
    );
    // Must NOT include Conversation 3 (no summary)
    assert.ok(
      !captured6.content.includes("Unsummarized Brainstorming"),
      "Must NOT include conversation without summary",
    );
    assert.ok(
      !captured6.content.includes("Brainstorming raw notes"),
      "Must NOT load raw messages from unsummarized conversation",
    );
    console.log("✓ Test 6 Passed: Conversations without summaries are completely ignored");

    // -------------------------------------------------------------
    // Test 7: Relevant Previous Conversation is Selected over Newer Unrelated Conversations
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing relevant previous conversation is selected over newer unrelated conversations...");
    // Create Conversation 5 for User A (newer than Conv 1)
    const conv5 = await conversationService.createConversation(userAId, {
      title: "Italian Cooking Recipes",
    });
    const conv5Id = conv5._id.toString();
    await Conversation.findByIdAndUpdate(conv5Id, {
      messageCount: 2,
      summary: "- What the conversation is about: Italian Cooking\n- What was completed: Authentic carbonara recipe\n- Where we stopped: Sourdough baking\n- Next step: Pizza dough",
      summaryUpdatedAt: new Date(Date.now() + 1000),
      lastSummarizedMessageCount: 2,
    });

    // Create Conversation 6 for User A (newest)
    const conv6 = await conversationService.createConversation(userAId, {
      title: "Mobile Weather App",
    });
    const conv6Id = conv6._id.toString();
    await Conversation.findByIdAndUpdate(conv6Id, {
      messageCount: 2,
      summary: "- What the conversation is about: Mobile Weather App\n- What was completed: OpenWeatherMap API integration\n- Where we stopped: Location permission handlers\n- Next step: UI styling",
      summaryUpdatedAt: new Date(Date.now() + 2000),
      lastSummarizedMessageCount: 2,
    });

    // In a new conversation, ask specifically about Stripe webhooks (which is in Conv 1, an older conversation)
    const res7 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What did we discuss about Stripe webhooks yesterday?",
      }),
    });

    assert.equal(res7.status, 200);
    const captured7 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    // Relevant conversation (Conv 1) must be selected
    assert.ok(
      captured7.content.includes('Previous conversation "Project Alpha Architecture":'),
      "Relevant older conversation must be selected based on query topic",
    );
    assert.ok(
      captured7.content.includes("Stripe webhook integration"),
      "Relevant conversation summary content must be present",
    );
    // Unrelated newer conversations (Cooking, Weather) must NOT be selected
    assert.ok(
      !captured7.content.includes("Italian Cooking Recipes"),
      "Unrelated newer conversation 'Italian Cooking Recipes' must NOT be selected",
    );
    assert.ok(
      !captured7.content.includes("Mobile Weather App"),
      "Unrelated newer conversation 'Mobile Weather App' must NOT be selected",
    );
    console.log("✓ Test 7 Passed: Relevant previous conversation selected over newer unrelated conversations");

    // -------------------------------------------------------------
    // Test 8: Unrelated Conversations are Not Unnecessarily Selected
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing unrelated conversations are NOT unnecessarily selected when asking about an unmentioned topic...");
    const res8 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What did we discuss about quantum physics in our previous session?",
      }),
    });

    assert.equal(res8.status, 200);
    const captured8 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    // Because user specifically asked for a topic that was never discussed,
    // none of the unrelated conversations (Stripe, Cooking, Weather) should be selected
    assert.ok(
      !captured8.content.includes("Previous conversation context:"),
      "Unrelated conversations must NOT be selected for a specific unmentioned topic",
    );
    assert.ok(
      !captured8.content.includes("Project Alpha Architecture"),
      "Project Alpha must NOT be selected for quantum physics query",
    );
    assert.ok(
      !captured8.content.includes("Italian Cooking"),
      "Italian Cooking must NOT be selected for quantum physics query",
    );
    console.log("✓ Test 8 Passed: Unrelated conversations are not unnecessarily selected");

    // -------------------------------------------------------------
    // Test 9: Generic Continuity Query Falls Back to Most Recent Conversation
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing generic continuity query falls back to most recent conversation...");
    const res9 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "Where did we stop?",
      }),
    });

    assert.equal(res9.status, 200);
    const captured9 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      captured9.content.includes("Previous conversation context:"),
      "Generic continuity query must retrieve previous conversation context",
    );
    // Newest conversation is Mobile Weather App (conv6)
    assert.ok(
      captured9.content.includes('Previous conversation "Mobile Weather App":'),
      "Generic continuity query must prioritize the most recent conversation",
    );
    console.log("✓ Test 9 Passed: Generic continuity query correctly falls back to most recent conversation");

    // -------------------------------------------------------------
    // Test 10: Broad Historical Queries ('what were we working on recently', etc.)
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing broad historical queries retrieve recent conversations...");
    const res10a = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What were we working on recently?",
      }),
    });

    assert.equal(res10a.status, 200);
    const captured10a = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured10a.content.includes("Previous conversation context:"),
      "Context must include previous conversations for 'What were we working on recently?'",
    );
    assert.ok(
      captured10a.content.includes('Previous conversation "Mobile Weather App":'),
      "Must include recent conversation for broad query",
    );

    const res10b = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What have we been working on?",
      }),
    });

    assert.equal(res10b.status, 200);
    const captured10b = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured10b.content.includes("Previous conversation context:"),
      "Context must include previous conversations for 'What have we been working on?'",
    );
    console.log("✓ Test 10 Passed: Broad historical queries successfully retrieve recent conversations");

    // -------------------------------------------------------------
    // Test 11: Specific Topic Historical Query ('What were we working on with Polar?')
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing specific topic query ('What were we working on with Polar?')...");
    // Create Conversation 7 for User A about Polar
    const conv7 = await conversationService.createConversation(userAId, {
      title: "Polar Payment Integration",
    });
    const conv7Id = conv7._id.toString();
    await Conversation.findByIdAndUpdate(conv7Id, {
      messageCount: 2,
      summary: "- What the conversation is about: Polar Subscription Integration\n- What was completed: Polar checkout webhooks and customer portal\n- Where we stopped: Subscription tier mapping\n- Next step: Test webhook signing secret",
      summaryUpdatedAt: new Date(Date.now() + 3000),
      lastSummarizedMessageCount: 2,
    });

    const res11 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What were we working on with Polar?",
      }),
    });

    assert.equal(res11.status, 200);
    const captured11 = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured11.content.includes("Previous conversation context:"),
      "Context must include previous conversation for Polar query",
    );
    assert.ok(
      captured11.content.includes("Polar Payment Integration") ||
      captured11.content.includes("Polar Subscription Integration"),
      "Context must select the Polar conversation",
    );
    assert.ok(
      captured11.content.includes("Subscription tier mapping"),
      "Context must contain Polar summary details",
    );
    assert.ok(
      !captured11.content.includes("Italian Cooking Recipes"),
      "Context must NOT include unrelated Italian Cooking conversation",
    );
    console.log("✓ Test 11 Passed: Specific topic query ('What were we working on with Polar?') correctly selected Polar conversation and excluded unrelated conversations");

    // -------------------------------------------------------------
    // Test 12: Phase 4 Resume & Where-We-Stopped Context Verification
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing Phase 4 Resume & Where-We-Stopped context...");

    // 12a: "where did we stop?"
    const res12a = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "where did we stop?",
      }),
    });
    assert.equal(res12a.status, 200);
    const captured12aContext = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    const captured12aSystem = mockProvider.capturedMessages[0]!;

    assert.ok(
      captured12aContext.content.includes("Previous conversation context:"),
      "Must include previous conversation context",
    );
    assert.ok(
      captured12aContext.content.includes("Resuming work guidance:"),
      "Must include resuming work guidance",
    );
    assert.ok(
      captured12aContext.content.includes("(1) what we were working on") &&
      captured12aContext.content.includes("(2) what was completed") &&
      captured12aContext.content.includes("(3) where the work stopped") &&
      captured12aContext.content.includes("(4) what the next step was"),
      "Guidance must instruct covering the 4 continuity components",
    );
    assert.ok(
      captured12aContext.content.includes("state explicitly that the next step is not available on record instead of guessing"),
      "Guidance must instruct against guessing or hallucinating next steps",
    );
    assert.ok(
      NEXAMIND_CHAT_SYSTEM_PROMPT.includes("Resuming Work & Where We Stopped:"),
      "System prompt must include Resuming Work instructions",
    );
    assert.ok(
      captured12aContext.content.includes("Subscription tier mapping"),
      "Context must include where we stopped from previous summary",
    );

    // 12b: "what was completed?"
    const res12b = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "what was completed?",
      }),
    });
    assert.equal(res12b.status, 200);
    const captured12bContext = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured12bContext.content.includes("Previous conversation context:"),
      "Must include previous conversation context for 'what was completed?'",
    );
    assert.ok(
      captured12bContext.content.includes("Polar checkout webhooks and customer portal"),
      "Context must include completed items from previous summary",
    );

    // 12c: "what should we continue?"
    const res12c = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "what should we continue?",
      }),
    });
    assert.equal(res12c.status, 200);
    const captured12cContext = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured12cContext.content.includes("Previous conversation context:"),
      "Must include previous conversation context for 'what should we continue?'",
    );
    assert.ok(
      captured12cContext.content.includes("Test webhook signing secret"),
      "Context must include next steps from previous summary",
    );

    // 12d: Verify behavior when summary has no clear next step
    const conv8 = await conversationService.createConversation(userAId, {
      title: "Backend Deployment",
    });
    const conv8Id = conv8._id.toString();
    await Conversation.findByIdAndUpdate(conv8Id, {
      messageCount: 3,
      summary: "- What the conversation is about: Production deploy\n- What was completed: AWS ECS cluster setup\n- Where we stopped: DNS propagation complete\n- Next step: None",
      summaryUpdatedAt: new Date(Date.now() + 5000),
      lastSummarizedMessageCount: 3,
    });

    const res12d = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "where did we leave off?",
      }),
    });
    assert.equal(res12d.status, 200);
    const captured12dContext = mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured12dContext.content.includes("DNS propagation complete"),
      "Context must reflect latest conversation where we stopped",
    );
    assert.ok(
      captured12dContext.content.includes("state explicitly that the next step is not available on record instead of guessing"),
      "Must strictly include the no-hallucination instruction when next step is not present",
    );

    console.log("✓ Test 12 Passed: Phase 4 Resume & Where-We-Stopped context accurately verified for all target queries and non-guessing constraints");

    // -------------------------------------------------------------
    // Test 13: Phase 5 Memory and Conversation Context Hardening
    // -------------------------------------------------------------
    console.log("\n[Test 13] Testing Phase 5 Memory and Conversation Context Hardening...");

    // 13a: Duplicate Prevention (identical summaries across conversations)
    console.log("  [13a] Duplicate prevention across multiple conversations...");
    const duplicateSummaryText =
      "- What the conversation is about: Clone workflow\n- What was completed: Step 1 completed\n- Where we stopped: Step 2\n- Next step: Run tests";
    const convDup1 = await conversationService.createConversation(userAId, {
      title: "Clone Workflow A",
    });
    const convDup2 = await conversationService.createConversation(userAId, {
      title: "Clone Workflow B",
    });
    await Conversation.findByIdAndUpdate(convDup1._id, {
      messageCount: 2,
      summary: duplicateSummaryText,
      summaryUpdatedAt: new Date(Date.now() + 6000),
      lastSummarizedMessageCount: 2,
    });
    await Conversation.findByIdAndUpdate(convDup2._id, {
      messageCount: 2,
      summary: duplicateSummaryText,
      summaryUpdatedAt: new Date(Date.now() + 7000),
      lastSummarizedMessageCount: 2,
    });

    const dupContext = await getContinuityContextForUser({
      userId: userAId,
      currentConversationId: conv4Id,
      userQuery: "what were we working on with Clone workflow?",
    });
    assert.ok(dupContext, "Continuity context must be returned for clone workflow");
    const occurrences = (dupContext.match(/Step 1 completed/g) || []).length;
    assert.equal(
      occurrences,
      1,
      "Duplicate summaries must be deduplicated into a single entry",
    );

    // 13b: Context Limits (per-summary cap and overall context budget)
    console.log("  [13b] Context limits and truncation...");
    const longSummaryText = "A".repeat(2500);
    const convLong = await conversationService.createConversation(userAId, {
      title: "Massive Task",
    });
    await Conversation.findByIdAndUpdate(convLong._id, {
      messageCount: 5,
      summary: longSummaryText,
      summaryUpdatedAt: new Date(Date.now() + 8000),
      lastSummarizedMessageCount: 5,
    });

    const longContext = await getContinuityContextForUser({
      userId: userAId,
      currentConversationId: conv4Id,
      userQuery: "what were we working on recently?",
    });
    assert.ok(longContext, "Continuity context must be returned");
    assert.ok(
      longContext.includes("[truncated]"),
      "Long summary must be cleanly truncated",
    );
    assert.ok(
      longContext.length <= MAX_CONTINUITY_CONTEXT_CHARS + 500,
      "Total continuity context must not exceed budget",
    );

    // 13c: Deleted Conversation Exclusion
    console.log("  [13c] Deleted conversation exclusion...");
    const convDeleted = await conversationService.createConversation(userAId, {
      title: "Secret Quantum Project",
    });
    await Conversation.findByIdAndUpdate(convDeleted._id, {
      messageCount: 4,
      summary:
        "- What the conversation is about: Quantum Algorithms\n- What was completed: Qubit simulation\n- Where we stopped: Decoherence tests\n- Next step: Benchmarking",
      summaryUpdatedAt: new Date(Date.now() + 9000),
      lastSummarizedMessageCount: 4,
      deletedAt: new Date(),
    });

    const deletedContext = await getContinuityContextForUser({
      userId: userAId,
      currentConversationId: conv4Id,
      userQuery: "what were we working on with Quantum Algorithms?",
    });
    assert.equal(
      deletedContext,
      null,
      "Soft-deleted conversations must be completely ignored",
    );

    // 13d: Strict Isolation & User Scoping
    console.log("  [13d] Strict cross-user isolation and scoping...");
    const convUserBConfidential = await conversationService.createConversation(
      userBId,
      { title: "User B Confidential Finance" },
    );
    await Conversation.findByIdAndUpdate(convUserBConfidential._id, {
      messageCount: 2,
      summary:
        "- What the conversation is about: Confidential Corporate Finances\n- What was completed: Balance sheet audited\n- Where we stopped: Tax compliance\n- Next step: Filing",
      summaryUpdatedAt: new Date(Date.now() + 10000),
      lastSummarizedMessageCount: 2,
    });

    const crossUserContext = await getContinuityContextForUser({
      userId: userAId, // User A querying
      currentConversationId: conv4Id,
      userQuery:
        "what were we working on with Confidential Corporate Finances?",
    });
    assert.equal(
      crossUserContext,
      null,
      "User A must NEVER retrieve User B's confidential conversation summary",
    );

    // 13e: Empty Retrieval & Fail-Open Chat Resilience
    console.log("  [13e] Empty retrieval and fail-open resilience...");
    const res13e = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "what were we working on with Ancient Martian Geology?",
      }),
    });
    assert.equal(
      res13e.status,
      200,
      "Chat must return 200 OK even when no historical continuity matches exist",
    );
    const captured13e =
      mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      !captured13e.content.includes("Previous conversation context:"),
      "Must omit previous conversation context section when no matches found",
    );

    console.log(
      "✓ Test 13 Passed: Phase 5 Memory & Context Hardening verified (duplicates, limits, deleted exclusion, scoping, fail-open)",
    );

    // -------------------------------------------------------------
    // Test 14: Regression Test for 'What were we working on with Polar?' & 'okay let's continue'
    // -------------------------------------------------------------
    console.log("\n[Test 14] Regression test for 'What were we working on with Polar?' across deep conversation history...");
    const res14 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "What were we working on with Polar?",
      }),
    });

    assert.equal(res14.status, 200, "Polar query must succeed with 200 OK");
    const captured14 =
      mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      captured14.content.includes("Previous conversation context:"),
      "Context must include previous conversation context for Polar query",
    );
    assert.ok(
      captured14.content.includes("Polar Payment Integration") ||
      captured14.content.includes("Polar Subscription Integration"),
      "Context must retrieve the Polar conversation even when older than 10 conversations",
    );
    // Explicitly verify the actual conversation.summary content reaches the final AI context
    assert.ok(
      captured14.content.includes("Polar checkout webhooks and customer portal"),
      "Final context must contain the actual summary's completed section",
    );
    assert.ok(
      captured14.content.includes("Subscription tier mapping"),
      "Final context must contain the actual summary's where-we-stopped section",
    );
    assert.ok(
      captured14.content.includes("Test webhook signing secret"),
      "Final context must contain the actual summary's next-step section",
    );
    assert.ok(
      !captured14.content.includes("Italian Cooking Recipes"),
      "Must not include unrelated conversations",
    );

    // Also verify directly via getContinuityContextForUser
    const directPolarContext = await getContinuityContextForUser({
      userId: userAId,
      currentConversationId: conv4Id,
      userQuery: "What were we working on with Polar?",
    });
    assert.ok(
      directPolarContext !== null,
      "Direct call to getContinuityContextForUser must return continuity context for Polar",
    );
    assert.ok(
      directPolarContext.includes("Polar Subscription Integration") &&
      directPolarContext.includes("Polar checkout webhooks and customer portal") &&
      directPolarContext.includes("Subscription tier mapping") &&
      directPolarContext.includes("Test webhook signing secret"),
      "Direct context must contain full actual Polar conversation summary content",
    );

    // Verify topic continuation: "okay let's continue with Polar"
    console.log("  [14b] Testing 'okay let's continue with Polar' identifies where we stopped...");
    const res14b = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "okay let's continue with Polar",
      }),
    });

    assert.equal(res14b.status, 200, "Follow-up 'okay let's continue with Polar' must succeed with 200 OK");
    const captured14b =
      mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;

    assert.ok(
      captured14b.content.includes("Previous conversation context:"),
      "Context must include continuity context for 'okay let's continue with Polar'",
    );
    assert.ok(
      captured14b.content.includes("Subscription tier mapping"),
      "Context must identify where we stopped for 'okay let's continue with Polar'",
    );
    assert.ok(
      captured14b.content.includes("Test webhook signing secret"),
      "Context must provide the next step for 'okay let's continue with Polar'",
    );

    // Verify generic continuity: "okay let's continue"
    console.log("  [14c] Testing generic 'okay let's continue' triggers continuity context...");
    const res14c = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: conv4Id,
        content: "okay let's continue",
      }),
    });

    assert.equal(res14c.status, 200, "Generic 'okay let's continue' must succeed with 200 OK");
    const captured14c =
      mockProvider.capturedMessages[mockProvider.capturedMessages.length - 1]!;
    assert.ok(
      captured14c.content.includes("Previous conversation context:"),
      "Generic 'okay let's continue' must trigger continuity context",
    );
    assert.ok(
      captured14c.content.includes("Resuming work guidance:"),
      "Generic 'okay let's continue' must include resuming work guidance",
    );

    // Verify system prompt instructs model to use supplied summaries directly and not disclaim details
    assert.ok(
      NEXAMIND_CHAT_SYSTEM_PROMPT.includes(
        "Do NOT claim that you lack the conversation summary, history, or details when a conversation summary is provided in context. Always use the provided summary content directly.",
      ),
      "System prompt must instruct model to not claim lacking summary details when summary is provided",
    );
    assert.ok(
      NEXAMIND_CHAT_SYSTEM_PROMPT.includes(
        "Base your answers regarding previous work, topics, or discussions on the supplied conversation summaries.",
      ),
      "System prompt must instruct model to base answers on supplied summaries",
    );

    console.log("✓ Test 14 Passed: Regression test for 'What were we working on with Polar?' and 'okay let's continue' verified with actual summary preservation");

    console.log("\n=============================================================");
    console.log("=== ALL CONVERSATION CONTINUITY TESTS PASSED (14/14) ========");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const users = await User.find({ email: { $in: [userAEmail, userBEmail] } });
      const ids = users.map((u) => u._id);
      if (ids.length > 0) {
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
  console.error("Cross-Conversation Continuity Test Suite Failed:", err);
  process.exit(1);
});
