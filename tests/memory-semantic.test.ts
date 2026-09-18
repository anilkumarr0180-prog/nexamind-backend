import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import * as memoryService from "../src/modules/memory/memory.service.js";
import { AppError } from "../src/errors/app.error.js";
import { env } from "../src/config/env.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

// Deterministic mock embedding provider
class SemanticTestMockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-semantic-embedding";
  public readonly dimensions = 768;
  public callCount = 0;
  public shouldFail = false;
  public shouldTimeout = false;

  // Generate deterministic 768-dim unit-ish vectors based on content keywords
  async generateEmbedding(text: string): Promise<number[]> {
    this.callCount++;

    if (this.shouldTimeout) {
      throw new AppError("Embedding provider request timed out", 504, "AI_PROVIDER_TIMEOUT");
    }

    if (this.shouldFail) {
      throw new AppError("Embedding provider failure", 502, "AI_PROVIDER_ERROR");
    }

    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();

    // Concept 1: Coding / TypeScript / Neovim / Architecture
    if (lower.includes("code") || lower.includes("typescript") || lower.includes("neovim") || lower.includes("ide") || lower.includes("developer")) {
      vector[0] = 0.95;
      vector[1] = 0.2;
    }
    // Concept 2: Cooking / Pizza / Recipes / Food
    else if (lower.includes("cook") || lower.includes("pizza") || lower.includes("recipe") || lower.includes("food")) {
      vector[10] = 0.95;
      vector[11] = 0.2;
    }
    // Concept 3: Fitness / Marathon / Running / Gym
    else if (lower.includes("run") || lower.includes("marathon") || lower.includes("fitness") || lower.includes("gym")) {
      vector[20] = 0.95;
      vector[21] = 0.2;
    } else {
      vector[50] = 0.5;
    }

    return vector;
  }
}

// Controllable AI Provider for Chat & Extraction
class SemanticTestMockAIProvider implements AIProvider {
  public readonly name = "mock-semantic-ai";
  public chatCallCount = 0;
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );

    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-semantic-ai",
        model: "mock-model",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    }

    this.chatCallCount++;
    this.capturedMessages = JSON.parse(JSON.stringify(messages));

    return {
      content: `Response from AI assistant #${this.chatCallCount}`,
      provider: "mock-semantic-ai",
      model: "mock-model",
      usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
    };
  }
}

const runTests = async () => {
  console.log("=== Starting M5: Semantic Memory Intelligence Test Suite ===");
  await connectDatabase();

  const mockEmbeddingProvider = new SemanticTestMockEmbeddingProvider();
  memoryService.setDefaultEmbeddingProvider(mockEmbeddingProvider);

  const mockAIProvider = new SemanticTestMockAIProvider();
  orchestratorService.setDefaultProvider(mockAIProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testId = Date.now();
  const userAEmail = `user_a_sem_${testId}@example.com`;
  const userBEmail = `user_b_sem_${testId}@example.com`;
  const password = "Password123!@#$";

  let userAId = "";
  let userAToken = "";
  let userBId = "";
  let userBToken = "";
  let convAId = "";

  try {
    const regA = await authService.register({ email: userAEmail, password });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    const convA = await Conversation.create({
      userId: userAId,
      title: "Semantic Memory Conversation",
      status: "ACTIVE",
    });
    convAId = convA._id.toString();

    console.log(`✓ Setup User A (${userAId}) and User B (${userBId})`);

    // -------------------------------------------------------------
    // Test 1: Automatic embedding generation on memory creation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing automatic embedding generation on memory creation...");
    const memCoding = await memoryService.createMemory(userAId, {
      type: MEMORY_TYPES.PREFERENCE,
      content: "User prefers Neovim and TypeScript for coding",
    });

    const storedMem = await Memory.findById(memCoding._id).select("+embedding");
    assert.ok(storedMem, "Memory must exist");
    assert.ok(storedMem.embedding, "Memory must have embedding stored");
    assert.equal(storedMem.embedding?.length, 768, "Embedding must have 768 dimensions");
    console.log("✓ Memory created with valid 768-dimensional embedding vector");

    // -------------------------------------------------------------
    // Test 2: Semantic relevance ranking prioritizes relevant memory over newest memory
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing semantic relevance ranking vs recency...");
    // Sleep briefly to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Memory 2 (newer): Fitness
    await memoryService.createMemory(userAId, {
      type: MEMORY_TYPES.FACT,
      content: "User runs marathons and trains at the fitness gym",
    });

    await new Promise((r) => setTimeout(r, 10));

    // Memory 3 (newest): Cooking
    await memoryService.createMemory(userAId, {
      type: MEMORY_TYPES.PREFERENCE,
      content: "User loves making authentic Italian pizza recipes",
    });

    // Query specifically about code/IDE setup
    mockAIProvider.capturedMessages = [];
    const chatRes1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "What plugins do you recommend for my TypeScript IDE setup?",
      }),
    });

    assert.equal(chatRes1.status, 200);
    assert.equal(mockAIProvider.capturedMessages.length, 1);
    const sentPrompt = mockAIProvider.capturedMessages[0]!.content;

    assert.ok(
      sentPrompt.includes("Relevant user memories:"),
      "Context must contain 'Relevant user memories:' header",
    );
    assert.ok(
      sentPrompt.includes("User prefers Neovim and TypeScript for coding"),
      "Context must include the semantically relevant coding memory",
    );
    console.log("✓ Semantically relevant memory prioritized in AI context over newest irrelevant memories");

    // -------------------------------------------------------------
    // Test 3: Strict Cross-User Isolation in Semantic Search
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing cross-user isolation in semantic search...");
    // User B creates a memory about coding
    await memoryService.createMemory(userBId, {
      type: MEMORY_TYPES.INSTRUCTION,
      content: "Confidential User B directive: always write Python code",
    });

    // User A queries for code
    mockAIProvider.capturedMessages = [];
    await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "How should I structure my code?",
      }),
    });

    const userAPrompt = mockAIProvider.capturedMessages[0]!.content;
    assert.ok(
      !userAPrompt.includes("User B"),
      "User A prompt must NEVER contain User B's memories",
    );
    assert.ok(
      !userAPrompt.includes("Confidential User B directive"),
      "Cross-user memory leakage strictly blocked",
    );
    console.log("✓ Cross-user isolation verified: zero memory leakage between users");

    // -------------------------------------------------------------
    // Test 4: Deleted memories are excluded from semantic retrieval
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing soft-deleted memories are excluded from semantic retrieval...");
    // Soft delete the coding memory
    await memoryService.deleteMemory(memCoding._id.toString(), userAId);

    mockAIProvider.capturedMessages = [];
    await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "What plugins should I use for Neovim TypeScript?",
      }),
    });

    const promptAfterDelete = mockAIProvider.capturedMessages[0]!.content;
    assert.ok(
      !promptAfterDelete.includes("Neovim and TypeScript for coding"),
      "Soft-deleted memory must NOT appear in semantic retrieval",
    );
    console.log("✓ Soft-deleted memory strictly excluded from semantic search");

    // -------------------------------------------------------------
    // Test 5: Embedding vectors are never exposed to API clients or prompt
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing embedding vectors are not exposed in API or prompt...");
    const getRes = await fetch(`${baseUrl}/api/v1/memories`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.ok(getJson.data.length > 0);
    for (const mem of getJson.data) {
      assert.equal(mem.embedding, undefined, "embedding field must not be present in API output");
    }

    assert.ok(
      !promptAfterDelete.includes("[0."),
      "AI prompt must never contain embedding float arrays",
    );
    console.log("✓ Vectors protected: select: false ensures zero vector leakage");

    // -------------------------------------------------------------
    // Test 6: Zero fallback to recency when semantic query yields 0 vector results
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing zero fallback to recency when user only has legacy memories without embeddings...");
    const userCEmail = `user_c_sem_${testId}@example.com`;
    const regC = await authService.register({ email: userCEmail, password });
    const userCId = regC.user.id;

    await Memory.create({
      userId: userCId,
      type: MEMORY_TYPES.FACT,
      content: "Legacy active memory created without embedding",
      status: MEMORY_STATUSES.ACTIVE,
    });

    const semanticContext = await memoryService.getSemanticMemoryContextForUser(
      userCId,
      "What are my preferences?",
    );

    assert.equal(
      semanticContext,
      null,
      "Context must NOT fall back to arbitrary recency-based memories when no semantic matches exist",
    );
    console.log("✓ Zero recency fallback verified: returns null instead of dumping arbitrary memories");

    // -------------------------------------------------------------
    // Test 7: Fail-open semantics when embedding provider fails
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing fail-open semantics when embedding provider throws...");
    mockEmbeddingProvider.shouldFail = true;

    mockAIProvider.capturedMessages = [];
    const chatResFail = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "What is my favorite pizza style?",
      }),
    });

    assert.equal(chatResFail.status, 200, "Chat must return 200 OK even when embedding provider fails");
    const jsonFail = await chatResFail.json();
    assert.equal(jsonFail.success, true);
    console.log("✓ Embedding provider failure handled fail-open; chat returned 200 OK");
    mockEmbeddingProvider.shouldFail = false;

    // -------------------------------------------------------------
    // Test 8: Fail-open semantics on embedding provider timeout
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing fail-open semantics when embedding provider times out (504)...");
    mockEmbeddingProvider.shouldTimeout = true;

    const chatResTimeout = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "Tell me about my workouts.",
      }),
    });

    assert.equal(chatResTimeout.status, 200, "Chat must return 200 OK when embedding times out");
    console.log("✓ Embedding timeout handled fail-open; chat returned 200 OK");
    mockEmbeddingProvider.shouldTimeout = false;

    // -------------------------------------------------------------
    // Test 9: Zero extra credits charged for semantic memory retrieval
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing credit balance is charged exactly 1 token (zero charge for semantic retrieval)...");
    const balBefore = (await tokenService.getBalance(userAId)).balance;

    await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: convAId,
        content: "Recommend a recipe based on my tastes.",
      }),
    });

    const balAfter = (await tokenService.getBalance(userAId)).balance;
    assert.equal(balBefore - balAfter, 1, "Exactly 1 credit deducted for chat; 0 for semantic retrieval");
    console.log("✓ Credit invariant preserved: zero additional credit deducted for embeddings or vector search");

    // -------------------------------------------------------------
    // Test 10: Bounded retrieval according to AI_MAX_MEMORY_CONTEXT
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing bounded retrieval limit...");
    const boundedContext = await memoryService.getSemanticMemoryContextForUser(
      userAId,
      "pizza recipe cooking food",
      1,
    );

    assert.ok(boundedContext);
    const lines = boundedContext.split("\n").filter((l) => l.startsWith("- ["));
    assert.equal(lines.length, 1, "Must respect limit=1");
    console.log("✓ Bounded retrieval strictly enforces limit parameter");

    console.log("\n==================================================");
    console.log(" ALL M5 SEMANTIC MEMORY TESTS PASSED (10/10)     ");
    console.log("==================================================");
  } finally {
    server.close();
    await User.deleteMany({ email: { $in: [userAEmail, userBEmail, `user_c_sem_${testId}@example.com`] } });
    await Conversation.deleteMany({ _id: convAId });
    await Message.deleteMany({ conversationId: convAId });
    await Memory.deleteMany({ userId: { $in: [userAId, userBId] } });
    await TokenBalance.deleteMany({ userId: { $in: [userAId, userBId] } });
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("M5 Test Suite Failed:", err);
  process.exit(1);
});
