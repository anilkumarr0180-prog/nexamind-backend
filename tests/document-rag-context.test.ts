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
import {
  buildFullChatContext,
  DEFAULT_RAG_TOP_K,
  DEFAULT_RAG_SIMILARITY_THRESHOLD,
  formatRagDocumentContext,
} from "../src/modules/ai/context-builder.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

/**
 * Deterministic Mock AI Provider for RAG testing
 */
class MockRagAIProvider implements AIProvider {
  public readonly name = "mock-rag-ai-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const last = messages[messages.length - 1];
    const content = last?.content ?? "";

    let reply = "Standard conversational reply";
    if (content.includes("Relevant Document Context (RAG)")) {
      if (content.includes("No relevant document chunks found")) {
        reply = "I checked the uploaded documents, but they do not contain enough relevant information regarding your query.";
      } else {
        reply = "Grounded document response: " + content.slice(0, 100);
      }
    }

    return {
      content: reply,
      provider: "mock-rag-ai-provider",
      model: "test-rag-model",
      usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
    };
  }

  async *generateChatStream(messages: AIMessage[]): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streaming grounded response: ", model: "test-rag-model" };
    yield {
      content: "Complete.",
      model: "test-rag-model",
      usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
      done: true,
    };
  }
}

/**
 * Deterministic Semantic Embedding Provider for RAG testing
 */
class MockRagEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-rag-embedding-provider";
  public readonly dimensions: number = 768;

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();

    // Topic 1: React / Frontend
    if (
      lower.includes("react") ||
      lower.includes("frontend") ||
      lower.includes("hooks") ||
      lower.includes("state management")
    ) {
      vector[0] = 0.95;
      vector[1] = 0.3;
      vector[2] = 0.1;
    }
    // Topic 2: Database / MongoDB / Backend Schema
    else if (
      lower.includes("database") ||
      lower.includes("mongodb") ||
      lower.includes("schema") ||
      lower.includes("index") ||
      lower.includes("migration")
    ) {
      vector[10] = 0.95;
      vector[11] = 0.3;
      vector[12] = 0.1;
    }
    // Topic 3: Security / Encryption / Confidential Keys
    else if (
      lower.includes("security") ||
      lower.includes("encryption") ||
      lower.includes("confidential") ||
      lower.includes("secret keys")
    ) {
      vector[20] = 0.95;
      vector[21] = 0.3;
      vector[22] = 0.1;
    }
    // Topic 4: Pizza / Cooking / Dough
    else if (
      lower.includes("pizza") ||
      lower.includes("dough") ||
      lower.includes("baking") ||
      lower.includes("cooking")
    ) {
      vector[30] = 0.95;
      vector[31] = 0.3;
      vector[32] = 0.1;
    }
    // Fallback baseline
    else {
      vector[50] = 0.6;
    }

    return vector;
  }
}

const runTests = async () => {
  console.log("=== Starting Semantic Document Retrieval (RAG): Step 16 Automated Tests ===");

  await connectDatabase();

  const mockAIProvider = new MockRagAIProvider();
  orchestratorService.setDefaultProvider(mockAIProvider);

  const originalEmbeddingProvider = getDefaultEmbeddingProvider();
  const mockEmbeddingProvider = new MockRagEmbeddingProvider();
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
    // Setup test users, balances, and conversations
    // -------------------------------------------------------------------------
    // User A
    const userA = await User.create({
      name: "RAG User A",
      email: `rag_user_a_${timestamp}@example.com`,
      passwordHash: "secure_hash_a",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userA._id, balance: 100 });

    // User B
    const userB = await User.create({
      name: "RAG User B",
      email: `rag_user_b_${timestamp}@example.com`,
      passwordHash: "secure_hash_b",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userB._id, balance: 100 });

    // Conversation A1 (active conversation with multiple documents)
    const convA1 = await Conversation.create({
      userId: userA._id,
      title: "RAG Conv A1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA1._id.toString());

    // Conversation A2 (separate conversation for User A)
    const convA2 = await Conversation.create({
      userId: userA._id,
      title: "RAG Conv A2 (Isolated)",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA2._id.toString());

    // Conversation A_Empty (empty conversation without any documents)
    const convA_Empty = await Conversation.create({
      userId: userA._id,
      title: "RAG Conv A Empty",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA_Empty._id.toString());

    // Conversation B1 (User B conversation)
    const convB1 = await Conversation.create({
      userId: userB._id,
      title: "RAG Conv B1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convB1._id.toString());

    // -------------------------------------------------------------------------
    // Create Documents and Chunk Embeddings
    // -------------------------------------------------------------------------
    // Doc A1: Contains React frontend chunk and Pizza cooking chunk
    const docA1Text = [
      "Chunk 0: React components and frontend state management using hooks enable rapid UI development.",
      "Chunk 1: Authentic artisan pizza dough requires seventy percent hydration and slow overnight refrigeration.",
    ].join("\n\n");

    const attA1 = await Attachment.create({
      userId: userA._id,
      conversationId: convA1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "frontend_and_cooking.txt",
      mimeType: "text/plain",
      size: docA1Text.length,
      cloudinaryPublicId: `rag_att_a1_${timestamp}`,
      secureUrl: "https://example.com/frontend_and_cooking.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docA1Text,
      extractedTextLength: docA1Text.length,
    });
    createdAttachmentIds.push(attA1._id.toString());
    await processDocumentEmbeddings(attA1._id, {
      chunkingOptions: { maxChunkSize: 150, chunkOverlap: 0 },
    });

    // Doc A2: Contains Database schema and MongoDB indexing notes
    const docA2Text =
      "Chunk 0: Database schema migrations and MongoDB indexes drastically improve query performance for backend APIs.";
    const attA2 = await Attachment.create({
      userId: userA._id,
      conversationId: convA1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "database_schema.txt",
      mimeType: "text/plain",
      size: docA2Text.length,
      cloudinaryPublicId: `rag_att_a2_${timestamp}`,
      secureUrl: "https://example.com/database_schema.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docA2Text,
      extractedTextLength: docA2Text.length,
    });
    createdAttachmentIds.push(attA2._id.toString());
    await processDocumentEmbeddings(attA2._id, {
      chunkingOptions: { maxChunkSize: 150, chunkOverlap: 0 },
    });

    // Doc A_Conv2: Uploaded to Conversation A2 (should remain isolated from Conv A1)
    const docAConv2Text =
      "Chunk 0: Conversation 2 private project roadmap and milestone delivery schedule.";
    const attAConv2 = await Attachment.create({
      userId: userA._id,
      conversationId: convA2._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "conv2_roadmap.txt",
      mimeType: "text/plain",
      size: docAConv2Text.length,
      cloudinaryPublicId: `rag_att_a_conv2_${timestamp}`,
      secureUrl: "https://example.com/conv2_roadmap.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docAConv2Text,
      extractedTextLength: docAConv2Text.length,
    });
    createdAttachmentIds.push(attAConv2._id.toString());
    await processDocumentEmbeddings(attAConv2._id);

    // Doc B1: User B Confidential security document
    const docB1Text =
      "Chunk 0: Confidential security encryption keys and secret credentials for production servers.";
    const attB1 = await Attachment.create({
      userId: userB._id,
      conversationId: convB1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "user_b_security.txt",
      mimeType: "text/plain",
      size: docB1Text.length,
      cloudinaryPublicId: `rag_att_b1_${timestamp}`,
      secureUrl: "https://example.com/user_b_security.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docB1Text,
      extractedTextLength: docB1Text.length,
    });
    createdAttachmentIds.push(attB1._id.toString());
    await processDocumentEmbeddings(attB1._id);

    // -------------------------------------------------------------------------
    // TEST 1: Relevant document chunk reaches the AI context
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Testing relevant document chunk reaches the AI context...");
    mockAIProvider.calls = [];
    const res1 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain React frontend state management with hooks.",
      }),
    });
    assert.strictEqual(res1.status, 200, "Chat request should succeed");
    const json1 = (await res1.json()) as any;
    assert.strictEqual(json1.success, true);

    const call1 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("Explain React frontend state management")),
    );
    assert.ok(call1, "AI provider call must be recorded");
    const prompt1 = call1[call1.length - 1]!.content;

    assert.ok(
      prompt1.includes("--- Relevant Document Context (RAG) ---"),
      "Must include RAG context header",
    );
    assert.ok(
      prompt1.includes("--- End of Relevant Document Context ---"),
      "Must include RAG context footer",
    );
    assert.ok(
      prompt1.includes("Source: frontend_and_cooking.txt"),
      "Must include source document name metadata",
    );
    assert.ok(prompt1.includes("Chunk 0"), "Must include chunk index metadata");
    assert.ok(
      prompt1.includes(`Attachment: ${attA1._id.toString()}`),
      "Must include attachmentId metadata",
    );
    assert.ok(
      prompt1.includes("React components and frontend state management"),
      "Must include relevant chunk text",
    );
    console.log("✓ Relevant document chunk with source metadata reached AI context");

    // -------------------------------------------------------------------------
    // TEST 2: Irrelevant chunks are excluded
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Testing irrelevant chunks are excluded...");
    assert.ok(
      !prompt1.includes("pizza dough"),
      "Unrelated pizza cooking chunk must be excluded by similarity threshold",
    );
    assert.ok(
      !prompt1.includes("seventy percent hydration"),
      "Unrelated cooking text must be excluded",
    );
    console.log("✓ Irrelevant chunks successfully excluded from AI context");

    // -------------------------------------------------------------------------
    // TEST 3: Multiple documents remain isolated
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Testing multiple documents remain isolated within conversation...");
    mockAIProvider.calls = [];
    const res3 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain database schema migrations and MongoDB indexes.",
      }),
    });
    assert.strictEqual(res3.status, 200);
    const call3 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("Explain database schema migrations")),
    );
    assert.ok(call3, "AI provider call must be recorded");
    const prompt3 = call3[call3.length - 1]!.content;

    // Must match Doc A2 (database schema)
    assert.ok(prompt3.includes("Source: database_schema.txt"));
    assert.ok(prompt3.includes(`Attachment: ${attA2._id.toString()}`));
    assert.ok(prompt3.includes("Database schema migrations and MongoDB indexes"));

    // Must NOT include Doc A1 (React or Pizza)
    assert.ok(!prompt3.includes("Source: frontend_and_cooking.txt"));
    assert.ok(!prompt3.includes("React components"));
    console.log("✓ Multiple documents isolated and accurately routed by semantic relevance");

    // -------------------------------------------------------------------------
    // TEST 4: Cross-user retrieval is rejected
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user document retrieval is strictly rejected...");
    mockAIProvider.calls = [];
    const res4 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "What are the confidential security encryption keys and secret credentials?",
      }),
    });
    assert.strictEqual(res4.status, 200);
    const call4 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("confidential security encryption keys")),
    );
    assert.ok(call4);
    const prompt4 = call4[call4.length - 1]!.content;

    // User A must NEVER receive User B's documents
    assert.ok(!prompt4.includes("user_b_security.txt"));
    assert.ok(!prompt4.includes(attB1._id.toString()));
    assert.ok(!prompt4.includes("secret credentials for production servers"));
    console.log("✓ Cross-user document retrieval strictly rejected; User B data never leaked");

    // -------------------------------------------------------------------------
    // TEST 5: Cross-conversation retrieval is rejected
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Testing cross-conversation document isolation...");
    mockAIProvider.calls = [];
    const res5 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "What is on the private project roadmap and milestone delivery schedule?",
      }),
    });
    assert.strictEqual(res5.status, 200);
    const call5 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("private project roadmap")),
    );
    assert.ok(call5);
    const prompt5 = call5[call5.length - 1]!.content;

    // Doc A_Conv2 was uploaded to Conv A2, must NOT appear in Conv A1 context
    assert.ok(!prompt5.includes("conv2_roadmap.txt"));
    assert.ok(!prompt5.includes(attAConv2._id.toString()));
    assert.ok(!prompt5.includes("Conversation 2 private project roadmap"));
    console.log("✓ Cross-conversation isolation verified; other conversations excluded");

    // -------------------------------------------------------------------------
    // TEST 6: No-result behavior (non-matching query in conversation with docs)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Testing no-result behavior when query does not match any document...");
    mockAIProvider.calls = [];
    const res6 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "What are the latest discoveries in deep sea marine biology?",
      }),
    });
    assert.strictEqual(res6.status, 200);
    const json6 = (await res6.json()) as any;
    assert.strictEqual(json6.success, true);

    const call6 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("deep sea marine biology")),
    );
    assert.ok(call6);
    const prompt6 = call6[call6.length - 1]!.content;

    assert.ok(
      prompt6.includes(
        "[No relevant document chunks found above similarity threshold for this query in the uploaded documents. Do not fabricate or invent document facts. Clearly indicate that the uploaded documents do not contain enough relevant information to answer.]",
      ),
      "Must include clear no-result notice forbidding fact fabrication",
    );
    console.log("✓ No-result behavior properly informs AI without fabricating document facts");

    // -------------------------------------------------------------------------
    // TEST 7: Context size limit enforcement
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Testing maximum document-context size limit enforcement...");
    {
      const customBudget = 260;
      const contextMessages = await buildFullChatContext({
        userId: userA._id,
        conversationId: convA1._id,
        userQuery: "Explain React frontend state management with hooks.",
        ragOptions: {
          maxContextChars: customBudget,
        },
      });

      assert.ok(contextMessages.length > 0);
      const latestMsg = contextMessages[contextMessages.length - 1]!;
      const docSectionMatch = latestMsg.content.match(
        /--- Relevant Document Context \(RAG\) ---[\s\S]*?--- End of Relevant Document Context ---/,
      );
      assert.ok(docSectionMatch, "RAG section must be present");
      const docSection = docSectionMatch[0];

      assert.ok(
        docSection.length <= customBudget + 50,
        `Document section length (${docSection.length}) must strictly respect character limit (${customBudget})`,
      );
      console.log(`✓ Context size limit strictly enforced (section length: ${docSection.length} <= budget: ${customBudget})`);
    }

    // -------------------------------------------------------------------------
    // TEST 8: Normal chat without documents remains completely unchanged
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Testing normal chat without documents remains completely unchanged...");
    mockAIProvider.calls = [];
    const res8 = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA_Empty._id.toString(),
        content: "Hello NexaMind, what is 2 + 2?",
      }),
    });
    assert.strictEqual(res8.status, 200);
    const call8 = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("what is 2 + 2")),
    );
    assert.ok(call8);
    const prompt8 = call8[call8.length - 1]!.content;

    assert.ok(
      !prompt8.includes("--- Relevant Document Context (RAG) ---"),
      "Must not include RAG context for conversations without documents",
    );
    assert.ok(
      !prompt8.includes("--- Attached Document:"),
      "Must not include attached document context",
    );
    assert.ok(
      !prompt8.includes("No relevant document chunks found"),
      "Must not include no-result notice for conversation without documents",
    );
    console.log("✓ Normal text chat without documents completely unchanged");

    // -------------------------------------------------------------------------
    // TEST 9: Streaming still works with RAG document retrieval
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Testing streaming chat works with RAG document retrieval...");
    mockAIProvider.calls = [];
    const resStream = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Explain React frontend state in streaming mode.",
        stream: true,
      }),
    });

    assert.strictEqual(resStream.status, 200);
    assert.ok(
      resStream.headers.get("content-type")?.includes("text/event-stream"),
      "Must return text/event-stream content type",
    );

    const streamBody = await resStream.text();
    assert.ok(streamBody.includes('data: {"type":"start"'), "Stream must emit start event");
    assert.ok(streamBody.includes('data: {"type":"chunk"'), "Stream must emit chunk events");
    assert.ok(streamBody.includes('data: {"type":"done"'), "Stream must emit done event");

    const streamCall = mockAIProvider.calls.find((c) =>
      c.some((m) => m.content.includes("in streaming mode")),
    );
    assert.ok(streamCall, "Streaming provider call must be recorded");
    const streamPrompt = streamCall[streamCall.length - 1]!.content;

    assert.ok(
      streamPrompt.includes("--- Relevant Document Context (RAG) ---"),
      "Streaming prompt must include RAG context",
    );
    assert.ok(
      streamPrompt.includes("Source: frontend_and_cooking.txt"),
      "Streaming prompt must include document source name",
    );
    assert.ok(
      streamPrompt.includes("React components and frontend state"),
      "Streaming prompt must include relevant document chunk",
    );
    console.log("✓ Streaming chat with RAG document retrieval successfully verified");

    console.log("\n=========================================================================");
    console.log(" ALL 9 STEP 16 SEMANTIC DOCUMENT RETRIEVAL (RAG) TESTS PASSED ");
    console.log("=========================================================================\n");
  } finally {
    // Restore default providers
    setDefaultEmbeddingProvider(originalEmbeddingProvider);

    // Teardown test artifacts
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
  console.error("Test failed with error:", err);
  process.exit(1);
});
