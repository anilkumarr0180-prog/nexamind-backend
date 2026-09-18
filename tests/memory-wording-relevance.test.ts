import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { GroqProvider } from "../src/modules/ai/providers/groq.provider.js";
import { NEXAMIND_CHAT_SYSTEM_PROMPT } from "../src/modules/ai/prompts/system.prompt.js";
import { TestMockEmbeddingProvider } from "./helpers/mock-embedding.helper.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class RelevanceMockAIProvider implements AIProvider {
  public readonly name = "mock-relevance-ai";
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );

    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: this.name,
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }

    this.capturedMessages = JSON.parse(JSON.stringify(messages));
    return {
      content: "I am NexaMind with memory capabilities.",
      provider: this.name,
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Memory Relevance & Assistant Wording Test Suite ===");
  await connectDatabase();

  const mockEmbeddingProvider = new TestMockEmbeddingProvider();
  memoryService.setDefaultEmbeddingProvider(mockEmbeddingProvider);

  const mockAIProvider = new RelevanceMockAIProvider();
  orchestratorService.setDefaultProvider(mockAIProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testId = Date.now();
  const userEmail = `rel_test_${testId}@example.com`;
  const password = "Password123!@#$";

  let userId = "";
  let userToken = "";
  let convId = "";

  try {
    const reg = await authService.register({ email: userEmail, password });
    userId = reg.user.id;
    userToken = reg.accessToken;

    const conv = await conversationService.createConversation(userId, {
      title: "Relevance Test Conversation",
    });
    convId = conv._id.toString();

    // -------------------------------------------------------------
    // Test 1: Seed memories for multiple distinct topics (Swift, Cooking, TypeScript)
    // -------------------------------------------------------------
    console.log("\n[Test 1] Seeding memories with distinct topic embeddings...");
    const swiftEmb = await mockEmbeddingProvider.generateEmbedding("User is building a Swift iOS app");
    // Force distinct vector for swift
    swiftEmb[30] = 0.95;
    swiftEmb[0] = 0.001; // ensure 0 similarity with code/typescript

    await Memory.create({
      userId,
      type: MEMORY_TYPES.FACT,
      content: "User is building a Swift mobile app",
      status: MEMORY_STATUSES.ACTIVE,
      embedding: swiftEmb,
    });

    const pizzaEmb = await mockEmbeddingProvider.generateEmbedding("User loves authentic Italian pizza");
    await Memory.create({
      userId,
      type: MEMORY_TYPES.PREFERENCE,
      content: "User loves authentic Italian pizza recipes",
      status: MEMORY_STATUSES.ACTIVE,
      embedding: pizzaEmb,
    });

    const tsEmb = await mockEmbeddingProvider.generateEmbedding("User prefers TypeScript and Express backend");
    await Memory.create({
      userId,
      type: MEMORY_TYPES.FACT,
      content: "User prefers TypeScript and Express for backend development",
      status: MEMORY_STATUSES.ACTIVE,
      embedding: tsEmb,
    });
    console.log("✓ Created 3 distinct active memories with vector embeddings");

    // -------------------------------------------------------------
    // Test 2: Unrelated meta-query 'do you have history of previous conversation' returns NULL
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing query 'do you have history of previous conversation' yields null (zero dumping)...");
    const historyContext = await memoryService.getSemanticMemoryContextForUser(
      userId,
      "do you have history of previous conversation",
    );
    assert.equal(
      historyContext,
      null,
      "Semantic memory retrieval must return null when no memories match minScore threshold",
    );
    console.log("✓ Zero recency dumping: meta-query received null memory context");

    // -------------------------------------------------------------
    // Test 3: HTTP Chat with 'do you have history of previous conversation' does NOT inject memories
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing HTTP chat turn with 'do you have history of previous conversation'...");
    mockAIProvider.capturedMessages = [];
    const chatRes1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        conversationId: convId,
        content: "do you have history of previous conversation",
      }),
    });

    assert.equal(chatRes1.status, 200);
    assert.equal(mockAIProvider.capturedMessages.length, 1);
    const prompt1 = mockAIProvider.capturedMessages[0]!.content;
    assert.ok(
      !prompt1.includes("Relevant user memories:"),
      "Must not include 'Relevant user memories:' block for unrelated question",
    );
    assert.ok(
      !prompt1.includes("Swift"),
      "Must NOT inject Swift memory into unrelated history question",
    );
    assert.ok(
      !prompt1.includes("pizza"),
      "Must NOT inject pizza memory into unrelated history question",
    );
    assert.equal(
      prompt1,
      "do you have history of previous conversation",
      "User message content must remain pristine without memory clutter",
    );
    console.log("✓ HTTP chat verified: zero irrelevant memories injected for conversation history meta-query");

    // -------------------------------------------------------------
    // Test 4: Relevant query receives ONLY semantically matching memory + grounding note
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing relevant query receives only matching memory and grounding note...");
    mockAIProvider.capturedMessages = [];
    const chatRes2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        conversationId: convId,
        content: "What backend language and framework do I use?",
      }),
    });

    assert.equal(chatRes2.status, 200);
    const prompt2 = mockAIProvider.capturedMessages[mockAIProvider.capturedMessages.length - 1]!.content;
    assert.ok(
      prompt2.includes("Relevant user memories:"),
      "Context must include 'Relevant user memories:'",
    );
    assert.ok(
      prompt2.includes("TypeScript and Express for backend development"),
      "Context must include the TypeScript memory",
    );
    assert.ok(
      !prompt2.includes("Swift"),
      "Context must NOT include Swift memory for a backend question",
    );
    assert.ok(
      !prompt2.includes("pizza"),
      "Context must NOT include pizza memory for a backend question",
    );
    assert.ok(
      prompt2.includes("Note: The above memories are persistent user facts from past sessions; do not claim they were mentioned in this conversation unless discussed in the current dialogue."),
      "Context must include grounding instruction to prevent assistant self-contradiction",
    );
    console.log("✓ Relevant query accurately matched single topic and included persistent grounding note");

    // -------------------------------------------------------------
    // Test 5: GroqProvider injects NEXAMIND_CHAT_SYSTEM_PROMPT when no system message exists
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing GroqProvider system prompt injection...");
    const groq = new GroqProvider("mock-key-for-unit-test");
    // Verify system prompt content
    assert.ok(NEXAMIND_CHAT_SYSTEM_PROMPT.includes("You are NexaMind"));
    assert.ok(NEXAMIND_CHAT_SYSTEM_PROMPT.includes("integrated long-term memory system"));
    assert.ok(NEXAMIND_CHAT_SYSTEM_PROMPT.includes("Do NOT claim that you lack long-term memory"));
    assert.ok(NEXAMIND_CHAT_SYSTEM_PROMPT.includes("were mentioned in the current conversation"));

    // Intercept fetch to inspect outbound payload to Groq API
    const originalFetch = globalThis.fetch;
    let outboundPayload: any = null;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      outboundPayload = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      // 5a: Standard chat without system message -> prepends NEXAMIND_CHAT_SYSTEM_PROMPT
      await groq.generateChatResponse([
        { role: "user", content: "Hello" },
      ]);
      assert.ok(outboundPayload);
      assert.equal(outboundPayload.messages[0].role, "system");
      assert.equal(outboundPayload.messages[0].content, NEXAMIND_CHAT_SYSTEM_PROMPT);
      assert.equal(outboundPayload.messages[1].role, "user");
      assert.equal(outboundPayload.messages[1].content, "Hello");
      console.log("✓ GroqProvider prepends NEXAMIND_CHAT_SYSTEM_PROMPT when messages lack system prompt");

      // 5b: Message with existing system prompt (e.g. Agent Loop) -> preserved, no duplicate
      outboundPayload = null;
      await groq.generateChatResponse([
        { role: "system", content: "Existing custom agent prompt" },
        { role: "user", content: "Perform task" },
      ]);
      assert.ok(outboundPayload);
      assert.equal(outboundPayload.messages.length, 2);
      assert.equal(outboundPayload.messages[0].role, "system");
      assert.equal(outboundPayload.messages[0].content, "Existing custom agent prompt");
      console.log("✓ GroqProvider preserves existing system prompt without duplication");
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log("\n==================================================================");
    console.log(" ALL MEMORY RELEVANCE & ASSISTANT WORDING TESTS PASSED (5/5)     ");
    console.log("==================================================================");
  } finally {
    server.close();
    await User.deleteMany({ email: userEmail });
    await Conversation.deleteMany({ _id: convId });
    await Message.deleteMany({ conversationId: convId });
    await Memory.deleteMany({ userId });
    await TokenBalance.deleteMany({ userId });
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Memory Relevance & Wording Test Suite Failed:", err);
  process.exit(1);
});
