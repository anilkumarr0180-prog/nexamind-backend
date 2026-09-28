import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import {
  processDocumentEmbeddings,
  setDefaultEmbeddingProvider,
  getDefaultEmbeddingProvider,
  deleteDocumentChunksByAttachmentId,
} from "../src/modules/attachments/attachment.service.js";
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_STATUSES,
} from "../src/modules/attachments/attachment.types.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

/**
 * Deterministic Mock AI Provider
 */
class MockCitationAIProvider implements AIProvider {
  public readonly name = "mock-citation-ai-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: "This response is grounded in the retrieved document chunks.",
      provider: "mock-citation-ai-provider",
      model: "test-citation-model",
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    };
  }

  async *generateChatStream(messages: AIMessage[]): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streaming answer grounded in citations: ", model: "test-citation-model" };
    yield {
      content: "Done.",
      model: "test-citation-model",
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      done: true,
    };
  }
}

/**
 * Deterministic Semantic Embedding Provider
 */
class MockCitationEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-citation-embedding-provider";
  public readonly dimensions: number = 768;

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();

    // Topic 1: React / Frontend
    if (
      lower.includes("react") ||
      lower.includes("frontend") ||
      lower.includes("hooks")
    ) {
      vector[0] = 0.95;
      vector[1] = 0.3;
      vector[2] = 0.1;
    }
    // Topic 2: Database / MongoDB / Indexes
    else if (
      lower.includes("database") ||
      lower.includes("mongodb") ||
      lower.includes("index")
    ) {
      vector[10] = 0.95;
      vector[11] = 0.3;
      vector[12] = 0.1;
    }
    // Topic 3: Confidential Keys / Security
    else if (
      lower.includes("confidential") ||
      lower.includes("security") ||
      lower.includes("secret keys")
    ) {
      vector[20] = 0.95;
      vector[21] = 0.3;
      vector[22] = 0.1;
    }
    // Fallback baseline
    else {
      vector[50] = 0.6;
    }

    return vector;
  }
}

const runTests = async () => {
  console.log("=== Starting Source Citations: Step 17 Automated Tests ===");

  await connectDatabase();

  const mockAIProvider = new MockCitationAIProvider();
  orchestratorService.setDefaultProvider(mockAIProvider);

  const originalEmbeddingProvider = getDefaultEmbeddingProvider();
  const mockEmbeddingProvider = new MockCitationEmbeddingProvider();
  setDefaultEmbeddingProvider(mockEmbeddingProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // Setup test users, conversations, and documents
    // -------------------------------------------------------------------------
    // User A
    const userA = await User.create({
      name: "Citation User A",
      email: `cite_user_a_${timestamp}@example.com`,
      passwordHash: "secure_hash_a",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userA._id, balance: 100 });

    // User B
    const userB = await User.create({
      name: "Citation User B",
      email: `cite_user_b_${timestamp}@example.com`,
      passwordHash: "secure_hash_b",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userB._id, balance: 100 });

    // Conv A1 (User A with documents)
    const convA1 = await Conversation.create({
      userId: userA._id,
      title: "Citation Conv A1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA1._id.toString());

    // Conv A_Empty (User A without documents)
    const convA_Empty = await Conversation.create({
      userId: userA._id,
      title: "Citation Conv A Empty",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA_Empty._id.toString());

    // Conv B1 (User B)
    const convB1 = await Conversation.create({
      userId: userB._id,
      title: "Citation Conv B1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convB1._id.toString());

    // Doc A1: Contains 2 chunks about React
    const docA1Text = [
      "Chunk 0: React components and JSX structure for frontend UI.",
      "Chunk 1: React hooks and state management patterns for modern frontend applications.",
    ].join("\n\n");

    const attA1 = await Attachment.create({
      userId: userA._id,
      conversationId: convA1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "react_guide.pdf",
      mimeType: "application/pdf",
      size: docA1Text.length,
      cloudinaryPublicId: `cite_att_a1_${timestamp}`,
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/react_guide.pdf",
      status: ATTACHMENT_STATUSES.READY,
      format: "pdf",
      extractedText: docA1Text,
      extractedTextLength: docA1Text.length,
    });
    createdAttachmentIds.push(attA1._id.toString());
    await processDocumentEmbeddings(attA1._id, {
      chunkingOptions: { maxChunkSize: 120, chunkOverlap: 0 },
    });

    // Doc B1: User B confidential document
    const docB1Text = "Chunk 0: Confidential security credentials and secret keys.";
    const attB1 = await Attachment.create({
      userId: userB._id,
      conversationId: convB1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "user_b_secrets.txt",
      mimeType: "text/plain",
      size: docB1Text.length,
      cloudinaryPublicId: `cite_att_b1_${timestamp}`,
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/user_b_secrets.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docB1Text,
      extractedTextLength: docB1Text.length,
    });
    createdAttachmentIds.push(attB1._id.toString());
    await processDocumentEmbeddings(attB1._id);

    // -------------------------------------------------------------------------
    // TEST 1: RAG answer includes correct sources
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Testing RAG answer includes correct source metadata...");
    const res1 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain React frontend components.",
      }),
    });
    assert.strictEqual(res1.status, 200);
    const json1 = (await res1.json()) as any;
    assert.strictEqual(json1.success, true);

    // Verify top-level sources and assistantMessage.sources
    assert.ok(json1.data.sources, "data.sources must exist");
    assert.ok(Array.isArray(json1.data.sources), "data.sources must be an array");
    assert.ok(json1.data.sources.length >= 1, "Must contain at least 1 source citation");

    const firstSource = json1.data.sources[0];
    assert.strictEqual(firstSource.attachmentId, attA1._id.toString(), "attachmentId must match");
    assert.strictEqual(firstSource.filename, "react_guide.pdf", "filename must match document originalName");
    assert.strictEqual(typeof firstSource.chunkIndex, "number", "chunkIndex must be a number");

    // Verify assistantMessage has identical sources
    assert.ok(json1.data.assistantMessage.sources, "assistantMessage.sources must exist");
    assert.strictEqual(json1.data.assistantMessage.sources[0].attachmentId, attA1._id.toString());
    assert.strictEqual(json1.data.assistantMessage.sources[0].filename, "react_guide.pdf");

    // Verify NO database secrets or embeddings exposed
    assert.strictEqual(firstSource.embedding, undefined, "Embeddings must NOT be exposed");
    assert.strictEqual(firstSource.cloudinaryPublicId, undefined, "Storage secrets must NOT be exposed");
    console.log("✓ RAG answer includes correct source citations without leaking secrets");

    // -------------------------------------------------------------------------
    // TEST 2: Multiple sources handled cleanly
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Testing multiple sources included when multiple chunks match...");
    const res2 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain React frontend components and hooks state management patterns.",
      }),
    });
    assert.strictEqual(res2.status, 200);
    const json2 = (await res2.json()) as any;
    assert.strictEqual(json2.success, true);
    assert.ok(json2.data.sources.length >= 2, "Should return multiple matching chunk sources");

    const indices = json2.data.sources.map((s: any) => s.chunkIndex);
    assert.ok(indices.includes(0), "Should include chunk 0");
    assert.ok(indices.includes(1), "Should include chunk 1");
    console.log(`✓ Multiple sources delivered successfully (${json2.data.sources.length} sources)`);

    // -------------------------------------------------------------------------
    // TEST 3: No-source normal chat returns null/empty sources
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Testing no-source normal chat does not include empty sources section...");
    // 3a. Chat in conversation with no documents
    const res3a = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA_Empty._id.toString(),
        content: "What is 10 + 10?",
      }),
    });
    assert.strictEqual(res3a.status, 200);
    const json3a = (await res3a.json()) as any;
    assert.strictEqual(json3a.data.sources, null, "Normal chat sources must be null");
    assert.strictEqual(json3a.data.assistantMessage.sources, null, "assistantMessage.sources must be null");

    // 3b. Query with no matching document chunks in conversation with docs
    const res3b = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "What is the capital of France?",
      }),
    });
    assert.strictEqual(res3b.status, 200);
    const json3b = (await res3b.json()) as any;
    assert.strictEqual(json3b.data.sources, null, "Unmatched query sources must be null");
    assert.strictEqual(json3b.data.assistantMessage.sources, null, "Unmatched assistantMessage.sources must be null");
    console.log("✓ Normal chat and unmatched query cleanly return null sources");

    // -------------------------------------------------------------------------
    // TEST 4: Cross-user source isolation
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user source isolation...");
    const res4 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "What are the confidential security credentials and secret keys?",
      }),
    });
    assert.strictEqual(res4.status, 200);
    const json4 = (await res4.json()) as any;
    const sources4 = json4.data.sources;

    if (sources4) {
      for (const s of sources4) {
        assert.notStrictEqual(
          s.attachmentId,
          attB1._id.toString(),
          "User A must NEVER receive User B's attachment as a source",
        );
        assert.notStrictEqual(s.filename, "user_b_secrets.txt");
      }
    }
    console.log("✓ Cross-user source isolation strictly verified; foreign sources never leaked");

    // -------------------------------------------------------------------------
    // TEST 5: Streaming source delivery (SSE events)
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Testing streaming source delivery via SSE...");
    const resStream = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain React frontend components in streaming mode.",
        stream: true,
      }),
    });

    assert.strictEqual(resStream.status, 200);
    const rawStreamText = await resStream.text();

    // 1. Verify "sources" event was emitted
    assert.ok(rawStreamText.includes('data: {"type":"sources"'), "Stream must emit sources event");
    const sourcesMatch = rawStreamText.match(/data: (\{"type":"sources",[\s\S]*?\})\n\n/);
    assert.ok(sourcesMatch, "Must find sources event payload");
    const sourcesEvent = JSON.parse(sourcesMatch[1]!);
    assert.strictEqual(sourcesEvent.type, "sources");
    assert.ok(Array.isArray(sourcesEvent.sources));
    assert.ok(sourcesEvent.sources.length >= 1);
    assert.strictEqual(sourcesEvent.sources[0].filename, "react_guide.pdf");
    assert.strictEqual(sourcesEvent.sources[0].attachmentId, attA1._id.toString());

    // 2. Verify "done" event includes sources
    assert.ok(rawStreamText.includes('data: {"type":"done"'), "Stream must emit done event");
    const doneMatch = rawStreamText.match(/data: (\{"type":"done",[\s\S]*?\})\n\n/);
    assert.ok(doneMatch, "Must find done event payload");
    const doneEvent = JSON.parse(doneMatch[1]!);
    assert.ok(doneEvent.sources, "Done event must include sources");
    assert.strictEqual(doneEvent.sources[0].filename, "react_guide.pdf");
    console.log("✓ Streaming source delivery verified with dedicated event and done payload");

    // -------------------------------------------------------------------------
    // TEST 6: Message history persistence
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Testing source citations are persisted in MongoDB and returned on message load...");
    const resHistory = await fetch(`${baseUrl}/conversations/${convA1._id.toString()}/messages`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(resHistory.status, 200);
    const jsonHistory = (await resHistory.json()) as any;
    assert.strictEqual(jsonHistory.success, true);

    const assistantMsgsWithSources = jsonHistory.data.filter(
      (m: any) => m.role === "ASSISTANT" && Array.isArray(m.sources) && m.sources.length > 0,
    );
    assert.ok(assistantMsgsWithSources.length >= 1, "Should find persisted assistant messages with sources");

    const savedSource = assistantMsgsWithSources[0].sources[0];
    assert.strictEqual(savedSource.attachmentId, attA1._id.toString());
    assert.strictEqual(savedSource.filename, "react_guide.pdf");
    assert.strictEqual(typeof savedSource.chunkIndex, "number");
    console.log("✓ Source citations successfully persisted and loaded from conversation history");

    console.log("\n=========================================================================");
    console.log(" ALL 6 STEP 17 SOURCE CITATIONS INTEGRATION TESTS PASSED ");
    console.log("=========================================================================\n");
  } finally {
    setDefaultEmbeddingProvider(originalEmbeddingProvider);
    server.close();
    for (const attId of createdAttachmentIds) {
      await deleteDocumentChunksByAttachmentId(attId).catch(() => {});
      await Attachment.findByIdAndDelete(attId).catch(() => {});
    }
    for (const convId of createdConversationIds) {
      await Conversation.findByIdAndDelete(convId).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await TokenBalance.deleteMany({ userId }).catch(() => {});
      await User.findByIdAndDelete(userId).catch(() => {});
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
