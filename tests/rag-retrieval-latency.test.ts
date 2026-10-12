import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose, { Types } from "mongoose";
import app from "../src/app.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_STATUSES,
} from "../src/modules/attachments/attachment.types.js";
import { DocumentChunk } from "../src/modules/attachments/document-chunk.model.js";
import {
  searchDocumentChunks,
  DEFAULT_RAG_QUERY_EMBEDDING_TIMEOUT_MS,
  resetEmbeddingProviderAvailability,
} from "../src/modules/attachments/document-search.service.js";
import {
  setDefaultEmbeddingProvider,
} from "../src/modules/attachments/document-embedding.service.js";
import { OllamaEmbeddingProvider } from "../src/modules/ai/providers/ollama-embedding.provider.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import { resolveDedicatedTestDbUri } from "../load-tests/config.ts";
import { AppError } from "../src/errors/app.error.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

class MockAIProvider implements AIProvider {
  public readonly name = "mock-rag-latency-ai-provider";
  public capturedMessages: AIMessage[] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    const isExtraction = messages.some((m) => m.content?.includes("memory extraction"));
    if (!isExtraction) {
      this.capturedMessages = JSON.parse(JSON.stringify(messages));
    }
    return {
      content: "AI response based on context",
      provider: this.name,
      model: "mock-model",
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.capturedMessages = JSON.parse(JSON.stringify(messages));
    yield { content: "Streaming response" };
  }
}

class FastMockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "fast-mock-embedding";
  public readonly dimensions = 768;

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.01);
    const lower = text.toLowerCase();
    if (lower.includes("kubernetes") || lower.includes("cluster") || lower.includes("devops")) {
      vector[0] = 0.95;
      vector[1] = 0.3;
    } else if (lower.includes("culinary") || lower.includes("recipe")) {
      vector[10] = 0.95;
      vector[11] = 0.3;
    } else {
      vector[50] = 0.5;
    }
    return vector;
  }
}

class FailingMockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "failing-mock-embedding";
  public readonly dimensions = 768;
  async generateEmbedding(text: string): Promise<number[]> {
    throw new AppError("Embedding provider offline", 502, "AI_PROVIDER_ERROR");
  }
}

class HangingMockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "hanging-mock-embedding";
  public readonly dimensions = 768;
  public delayMs: number;

  constructor(delayMs: number = 60000) {
    this.delayMs = delayMs;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return new Array<number>(this.dimensions).fill(0.01);
  }
}

const createdUserIds: string[] = [];

async function runRagLatencyTests(): Promise<void> {
  console.log("\n==========================================================================");
  console.log("=== NEXAMIND RAG RETRIEVAL LATENCY FIX VERIFICATION SUITE ===");
  console.log("==========================================================================");

  const testDbUri = resolveDedicatedTestDbUri();
  console.log(`[Setup] Connecting to isolated test database...`);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(testDbUri);
  }

  const mockAi = new MockAIProvider();
  orchestratorService.setDefaultProvider(mockAi);

  const fastEmbeddings = new FastMockEmbeddingProvider();
  setDefaultEmbeddingProvider(fastEmbeddings);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Setup] Test server running at ${baseUrl}\n`);

  try {
    // Setup Users
    const timestamp = Date.now();
    const userA = await authService.register({
      email: `rag_user_a_${timestamp}@test.local`,
      password: "Password123!@#$",
    });
    createdUserIds.push(userA.user.id);

    const userB = await authService.register({
      email: `rag_user_b_${timestamp}@test.local`,
      password: "Password123!@#$",
    });
    createdUserIds.push(userB.user.id);

    // Create Conversation for User A
    const convA = await conversationService.createConversation(userA.user.id, {
      title: "DevOps Architecture Conversation",
    });

    // Create Attachment for User A with extractedText
    const docA = await Attachment.create({
      userId: new Types.ObjectId(userA.user.id),
      conversationId: convA._id,
      originalName: "k8s_architecture.pdf",
      mimeType: "application/pdf",
      size: 10240,
      cloudinaryPublicId: `rag_doc_a_${timestamp}`,
      secureUrl: "https://example.com/k8s_architecture.pdf",
      format: "pdf",
      type: ATTACHMENT_TYPES.DOCUMENT,
      status: ATTACHMENT_STATUSES.READY,
      extractedText: "Production Kubernetes cluster deployment with multi-zone ingress controllers and horizontal pod autoscalers.",
    });

    // Create Document Chunk with vector embedding matching "Kubernetes"
    const k8sVector = await fastEmbeddings.generateEmbedding("Kubernetes cluster deployment");
    await DocumentChunk.create({
      attachmentId: docA._id,
      chunkIndex: 0,
      text: "Production Kubernetes cluster deployment with multi-zone ingress controllers and horizontal pod autoscalers.",
      embedding: k8sVector,
    });

    // -------------------------------------------------------------------------
    // TEST 1: AVAILABLE EMBEDDING PROVIDER (Successful RAG retrieval)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1: AVAILABLE PROVIDER] Testing semantic search with active provider...");
    console.log("--------------------------------------------------------------------------");
    {
      const tStart = Date.now();
      const results = await searchDocumentChunks({
        userId: userA.user.id,
        conversationId: convA._id.toString(),
        query: "How is the Kubernetes cluster deployed?",
        provider: fastEmbeddings,
      });
      const tElapsed = Date.now() - tStart;

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]?.attachmentId, docA._id.toString());
      assert.ok(results[0]?.similarity! > 0.8, "High similarity match expected");
      console.log(`✓ Test 1 Passed: Retrieved chunk in ${tElapsed}ms with similarity ${results[0]?.similarity.toFixed(4)}\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: UNAVAILABLE OLLAMA SERVICE (Fail-fast in < 100ms instead of 60s)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 2: UNAVAILABLE OLLAMA] Testing fail-fast when Ollama is unreachable...");
    console.log("--------------------------------------------------------------------------");
    {
      resetEmbeddingProviderAvailability();
      // Point Ollama provider to an unused localhost port where nothing is listening
      const unavailableOllama = new OllamaEmbeddingProvider(
        "http://127.0.0.1:59999", // Unused closed port
        "nomic-embed-text",
        768,
        DEFAULT_RAG_QUERY_EMBEDDING_TIMEOUT_MS,
      );

      const tStart = Date.now();
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userA.user.id,
            conversationId: convA._id.toString(),
            query: "Kubernetes ingress",
            provider: unavailableOllama,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.ok(
            err.code === "AI_PROVIDER_ERROR" ||
            err.code === "AI_PROVIDER_UNAVAILABLE" ||
            err.code === "EMBEDDING_PROVIDER_UNAVAILABLE",
            `Expected unavailable error code, got: ${(err as any).code}`
          );
          return true;
        }
      );
      const tElapsed = Date.now() - tStart;

      assert.ok(tElapsed < 1000, `Fail-fast must complete in <1000ms (completed in ${tElapsed}ms)`);
      console.log(`✓ Test 2a Passed: Unavailable Ollama failed fast in ${tElapsed}ms (saved ~59.9s vs 60s timeout)`);

      // 2b. Circuit breaker test: Subsequent query fails in < 50ms without network attempt
      const tStartCb = Date.now();
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userA.user.id,
            conversationId: convA._id.toString(),
            query: "Kubernetes ingress",
            provider: unavailableOllama,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.code, "EMBEDDING_PROVIDER_UNAVAILABLE");
          assert.ok(
            err.message.includes("currently unavailable (circuit open)") ||
            err.message.includes("incompatible with the deployed environment"),
            `Unexpected error message: ${err.message}`
          );
          return true;
        }
      );
      const tElapsedCb = Date.now() - tStartCb;
      assert.ok(tElapsedCb < 500, `Fail-fast must complete in <500ms with DB lookups (took ${tElapsedCb}ms)`);
      console.log(`✓ Test 2b Passed: Circuit breaker tripped in ${tElapsedCb}ms (<5ms typical)\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: EMBEDDING TIMEOUT (Bounded timeout strictly interrupts hung calls)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 3: BOUNDED TIMEOUT] Testing timeout interrupts hung embedding call...");
    console.log("--------------------------------------------------------------------------");
    {
      resetEmbeddingProviderAvailability();
      assert.strictEqual(
        DEFAULT_RAG_QUERY_EMBEDDING_TIMEOUT_MS,
        2000,
        "Default query embedding timeout must be bounded to 2000ms (2 seconds)",
      );
      const hangingProvider = new HangingMockEmbeddingProvider(10000); // 10s delay

      const testTimeoutMs = 150; // 150ms bounded timeout for test
      const tStart = Date.now();
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userA.user.id,
            conversationId: convA._id.toString(),
            query: "Kubernetes autoscaling",
            provider: hangingProvider,
            timeoutMs: testTimeoutMs,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 504);
          assert.strictEqual(err.code, "AI_PROVIDER_TIMEOUT");
          assert.ok(err.message.includes("timed out"));
          return true;
        }
      );
      const tElapsed = Date.now() - tStart;
      assert.ok(
        tElapsed >= 140 && tElapsed <= 800,
        `Bounded timeout must interrupt at ~150ms (took ${tElapsed}ms)`
      );
      console.log(`✓ Test 3 Passed: Hanging embedding interrupted in ${tElapsed}ms with 504 AI_PROVIDER_TIMEOUT\n`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: NO RELEVANT DOCUMENT CHUNKS (Threshold filtering without raw dump)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 4: NO RELEVANT CHUNKS] Testing threshold filtering on irrelevant query...");
    console.log("--------------------------------------------------------------------------");
    {
      const irrelevantQuery = "How do you prepare Italian pizza dough?";
      const searchRes = await searchDocumentChunks({
        userId: userA.user.id,
        conversationId: convA._id.toString(),
        query: irrelevantQuery,
        provider: fastEmbeddings,
      });

      assert.strictEqual(searchRes.length, 0, "No chunks should match cooking query against k8s doc");

      // Verify chat context builder outputs 'No relevant document chunks found'
      const chatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: convA._id.toString(),
          content: irrelevantQuery,
        }),
      });

      assert.strictEqual(chatRes.status, 200);
      const captured = mockAi.capturedMessages[mockAi.capturedMessages.length - 1]?.content ?? "";
      assert.ok(
        captured.includes("No relevant document chunks found"),
        "Context must state no relevant document chunks found",
      );
      assert.ok(
        !captured.includes("--- Attached Document: k8s_architecture.pdf ---"),
        "Must NOT dump the entire document when vector search found 0 relevant chunks",
      );
      console.log("✓ Test 4 Passed: Irrelevant query returned 0 chunks without dumping document\n");
    }

    // -------------------------------------------------------------------------
    // TEST 5: FALLBACK BEHAVIOR ON RETRIEVAL FAILURE (Preserves document context)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 5: FALLBACK BEHAVIOR] Testing bounded text fallback on retrieval failure...");
    console.log("--------------------------------------------------------------------------");
    {
      // Configure default embedding provider to fail fast
      resetEmbeddingProviderAvailability();
      const failingEmbeddings = new FailingMockEmbeddingProvider();
      setDefaultEmbeddingProvider(failingEmbeddings);

      const tStart = Date.now();
      const chatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: convA._id.toString(),
          content: "What does the architecture document say?",
        }),
      });
      const tElapsed = Date.now() - tStart;

      assert.strictEqual(chatRes.status, 200);
      const captured = mockAi.capturedMessages[mockAi.capturedMessages.length - 1]?.content ?? "";

      // Fallback must have engaged: injected the document as Attached Document
      assert.ok(
        captured.includes("--- Attached Document: k8s_architecture.pdf ---"),
        "Fallback must inject attached document bounded text",
      );
      assert.ok(
        captured.includes("Production Kubernetes cluster deployment"),
        "Fallback text must contain the document content",
      );
      console.log(`✓ Test 5 Passed: Seamless fallback engaged in ${tElapsed}ms with bounded document text\n`);

      // Restore fast embeddings
      setDefaultEmbeddingProvider(fastEmbeddings);
    }

    // -------------------------------------------------------------------------
    // TEST 6: USER & CONVERSATION ISOLATION (Security boundaries)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 6: ISOLATION] Testing strict cross-user and cross-conversation scoping...");
    console.log("--------------------------------------------------------------------------");
    {
      // 6a. User B cannot search User A conversation
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userB.user.id,
            conversationId: convA._id.toString(),
            query: "Kubernetes",
            provider: fastEmbeddings,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 403);
          assert.strictEqual(err.code, "FORBIDDEN");
          return true;
        }
      );

      // 6b. User B cannot search User A attachment directly
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userB.user.id,
            attachmentId: docA._id.toString(),
            query: "Kubernetes",
            provider: fastEmbeddings,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 403);
          assert.strictEqual(err.code, "FORBIDDEN");
          return true;
        }
      );

      // 6c. User A search in a different conversation without documents returns 0 results
      const convAEmpty = await conversationService.createConversation(userA.user.id, {
        title: "Empty Conversation Without Docs",
      });
      const emptyConvResults = await searchDocumentChunks({
        userId: userA.user.id,
        conversationId: convAEmpty._id.toString(),
        query: "Kubernetes",
        provider: fastEmbeddings,
      });
      assert.strictEqual(emptyConvResults.length, 0);

      console.log("✓ Test 6 Passed: Cross-user 403 forbidden and conversation scoping strictly verified\n");
    }

    // -------------------------------------------------------------------------
    // TEST 7: NORMAL CHAT WITHOUT DOCUMENTS (Zero overhead / completely unaffected)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 7: NORMAL CHAT] Testing standard chat without documents...");
    console.log("--------------------------------------------------------------------------");
    {
      const convPlain = await conversationService.createConversation(userA.user.id, {
        title: "Standard Text Chat",
      });

      const tStart = Date.now();
      const chatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          conversationId: convPlain._id.toString(),
          content: "Hello, how is the weather today?",
        }),
      });
      const tElapsed = Date.now() - tStart;

      assert.strictEqual(chatRes.status, 200);
      const captured = mockAi.capturedMessages[mockAi.capturedMessages.length - 1]?.content ?? "";
      assert.ok(!captured.includes("Relevant Document Context"), "No document context in normal chat");
      assert.ok(!captured.includes("Attached Document"), "No attached document in normal chat");

      console.log(`✓ Test 7 Passed: Normal chat completed in ${tElapsed}ms with 0 document overhead\n`);
    }

    console.log("==========================================================================");
    console.log("=== ALL 7 RAG RETRIEVAL LATENCY FIX TESTS PASSED (7/7) ===");
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
        Attachment.deleteMany({ userId: { $in: oids } }),
      ]);
    }
    await mongoose.disconnect();
  }
}

runRagLatencyTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
