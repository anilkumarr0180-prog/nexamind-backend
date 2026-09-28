import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import {
  processDocumentEmbeddings,
  semanticDocumentSearch,
  searchDocumentChunks,
  calculateCosineSimilarity,
  DEFAULT_DOCUMENT_SEARCH_LIMIT,
  DEFAULT_DOCUMENT_SIMILARITY_THRESHOLD,
  setDefaultEmbeddingProvider,
  getDefaultEmbeddingProvider,
  deleteDocumentChunksByAttachmentId,
} from "../src/modules/attachments/attachment.service.js";
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_STATUSES,
} from "../src/modules/attachments/attachment.types.js";
import { AppError } from "../src/errors/app.error.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

/**
 * Deterministic semantic test embedding provider
 */
class TestSearchEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "test-search-embedding-provider";
  public readonly dimensions: number = 768;
  public callCount = 0;
  public shouldFail = false;
  public failError = new AppError("Simulated embedding provider failure", 502, "AI_PROVIDER_ERROR");

  async generateEmbedding(text: string): Promise<number[]> {
    this.callCount++;

    if (this.shouldFail) {
      throw this.failError;
    }

    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();

    // Topic 1: Programming / TypeScript / Software Architecture
    if (
      lower.includes("typescript") ||
      lower.includes("code") ||
      lower.includes("programming") ||
      lower.includes("architecture") ||
      lower.includes("software")
    ) {
      vector[0] = 0.95;
      vector[1] = 0.3;
      vector[2] = 0.1;
    }
    // Topic 2: Cooking / Food / Recipes / Pizza
    else if (
      lower.includes("cook") ||
      lower.includes("pizza") ||
      lower.includes("recipe") ||
      lower.includes("dough") ||
      lower.includes("baking") ||
      lower.includes("sourdough")
    ) {
      vector[10] = 0.95;
      vector[11] = 0.3;
      vector[12] = 0.1;
    }
    // Topic 3: Fitness / Athletics / Running
    else if (
      lower.includes("fitness") ||
      lower.includes("running") ||
      lower.includes("marathon")
    ) {
      vector[20] = 0.95;
      vector[21] = 0.3;
      vector[22] = 0.1;
    }
    // Fallback baseline vector
    else {
      vector[50] = 0.6;
    }

    return vector;
  }
}

const runTests = async () => {
  console.log("=== Starting Semantic Document Search: Step 15 Automated Tests ===");

  await connectDatabase();

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  const originalDefaultProvider = getDefaultEmbeddingProvider();
  const searchMockProvider = new TestSearchEmbeddingProvider();
  setDefaultEmbeddingProvider(searchMockProvider);

  try {
    // -------------------------------------------------------------------------
    // Setup test users, conversations, documents and chunk embeddings
    // -------------------------------------------------------------------------
    // User A
    const userA = await User.create({
      name: "Search User A",
      email: `search_user_a_${timestamp}@example.com`,
      passwordHash: "secure_hash_a",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());

    // Conversation A1 (with documents)
    const convA1 = await Conversation.create({
      userId: userA._id,
      title: "User A Conversation 1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA1._id.toString());

    // Conversation A2 (with a different document)
    const convA2 = await Conversation.create({
      userId: userA._id,
      title: "User A Conversation 2",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA2._id.toString());

    // Conversation A3 (empty - no documents)
    const convA3 = await Conversation.create({
      userId: userA._id,
      title: "User A Conversation 3 (Empty)",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA3._id.toString());

    // User B
    const userB = await User.create({
      name: "Search User B",
      email: `search_user_b_${timestamp}@example.com`,
      passwordHash: "secure_hash_b",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());

    // Conversation B1 (User B)
    const convB1 = await Conversation.create({
      userId: userB._id,
      title: "User B Conversation 1",
      status: "ACTIVE",
    });
    createdConversationIds.push(convB1._id.toString());

    // Create Document 1 in Conv A1: Contains both Programming chunks and Cooking chunks
    const docA1Text = [
      "Chunk 0: NexaMind system architecture utilizes TypeScript and React for building scalable software.",
      "Chunk 1: Modern programming workflows benefit from strict compiler checks and clean code patterns.",
      "Chunk 2: Authentic Italian pizza dough requires slow cold fermentation and high hydration flour.",
      "Chunk 3: Baking artisan sourdough bread demands careful steam injection and temperature control.",
    ].join("\n\n");

    const attA1 = await Attachment.create({
      userId: userA._id,
      conversationId: convA1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "user_a_doc1.txt",
      mimeType: "text/plain",
      size: docA1Text.length,
      cloudinaryPublicId: `dummy_search_a1_${timestamp}`,
      secureUrl: "https://example.com/user_a_doc1.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docA1Text,
      extractedTextLength: docA1Text.length,
    });
    createdAttachmentIds.push(attA1._id.toString());

    // Process embeddings for Document A1 (use maxChunkSize: 150, chunkOverlap: 0 to keep each topic chunk distinct)
    await processDocumentEmbeddings(attA1._id, {
      chunkingOptions: { maxChunkSize: 150, chunkOverlap: 0 },
    });

    // Create Document 2 in Conv A2: User A's second conversation
    const docA2Text = "TypeScript compiler options configure strict typechecking for backend API microservices.";
    const attA2 = await Attachment.create({
      userId: userA._id,
      conversationId: convA2._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "user_a_doc2.txt",
      mimeType: "text/plain",
      size: docA2Text.length,
      cloudinaryPublicId: `dummy_search_a2_${timestamp}`,
      secureUrl: "https://example.com/user_a_doc2.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docA2Text,
      extractedTextLength: docA2Text.length,
    });
    createdAttachmentIds.push(attA2._id.toString());
    await processDocumentEmbeddings(attA2._id);

    // Create Document B1 in Conv B1: User B's document
    const docB1Text = "User B confidential document discussing TypeScript and programming internals.";
    const attB1 = await Attachment.create({
      userId: userB._id,
      conversationId: convB1._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "user_b_doc1.txt",
      mimeType: "text/plain",
      size: docB1Text.length,
      cloudinaryPublicId: `dummy_search_b1_${timestamp}`,
      secureUrl: "https://example.com/user_b_doc1.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: docB1Text,
      extractedTextLength: docB1Text.length,
    });
    createdAttachmentIds.push(attB1._id.toString());
    await processDocumentEmbeddings(attB1._id);

    // -------------------------------------------------------------------------
    // TEST 1: Relevant chunk ranked first
    // -------------------------------------------------------------------------
    console.log("[Test 1] Testing relevant chunk ranked first...");
    {
      const results = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "TypeScript software architecture",
      });

      assert.ok(results.length > 0, "Should return matching chunks");
      const topChunk = results[0]!;

      // Chunk 0 specifically discusses "TypeScript and React for building scalable software"
      assert.strictEqual(topChunk.chunkIndex, 0, "Top ranked chunk must be Chunk 0 (TypeScript architecture)");
      assert.strictEqual(topChunk.attachmentId, attA1._id.toString());
      assert.ok(topChunk.text.includes("TypeScript"));
      assert.ok(topChunk.similarity > 0.8, `Expected high similarity score >0.8, got ${topChunk.similarity}`);
      assert.strictEqual(topChunk.score, topChunk.similarity);

      // Verify returned shape contains all 4 required fields
      assert.ok("attachmentId" in topChunk);
      assert.ok("chunkIndex" in topChunk);
      assert.ok("text" in topChunk);
      assert.ok("similarity" in topChunk);
      assert.ok("score" in topChunk);

      console.log(`✓ Most relevant chunk ranked first (similarity: ${topChunk.similarity.toFixed(4)})`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Unrelated chunks filtered out
    // -------------------------------------------------------------------------
    console.log("[Test 2] Testing unrelated chunks filtered by default threshold...");
    {
      const results = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "TypeScript programming code",
        minSimilarity: 0.5,
      });

      // Pizza and sourdough chunks must NOT be present
      for (const res of results) {
        assert.ok(!res.text.includes("pizza"), "Pizza chunk should be filtered out as unrelated");
        assert.ok(!res.text.includes("sourdough"), "Sourdough chunk should be filtered out as unrelated");
        assert.ok(res.similarity >= 0.5, `Each result must exceed 0.5 threshold, got ${res.similarity}`);
      }

      console.log("✓ Unrelated chunks (cooking/pizza) strictly filtered out from programming search");
    }

    // -------------------------------------------------------------------------
    // TEST 3: Top-K limit
    // -------------------------------------------------------------------------
    console.log("[Test 3] Testing top-K bounding and limits...");
    {
      const searchRes1 = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "TypeScript programming",
        limit: 1,
      });
      assert.strictEqual(searchRes1.length, 1, "Limit: 1 should return exactly 1 chunk");

      const searchRes2 = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "TypeScript programming",
        limit: 2,
      });
      assert.strictEqual(searchRes2.length, 2, "Limit: 2 should return exactly 2 chunks");

      // Verify order is preserved: rank 1 in limit=2 must equal the result in limit=1
      assert.strictEqual(searchRes1[0]!.chunkIndex, searchRes2[0]!.chunkIndex);
      assert.strictEqual(searchRes1[0]!.similarity, searchRes2[0]!.similarity);

      console.log("✓ Top-K limit strictly enforced and deterministic across limits");
    }

    // -------------------------------------------------------------------------
    // TEST 4: Similarity threshold control
    // -------------------------------------------------------------------------
    console.log("[Test 4] Testing similarity threshold filtering...");
    {
      // High threshold
      const strictResults = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "pizza baking dough",
        minSimilarity: 0.85,
      });
      assert.ok(strictResults.length >= 1, "Should match pizza chunk with high threshold");
      for (const r of strictResults) {
        assert.ok(r.similarity >= 0.85);
      }

      // Query without matching keywords has similarity ~0.002, filtered out by 0.5 threshold
      const belowThresholdResults = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "generic astronomy telescopes universe",
        minSimilarity: 0.5,
      });
      assert.strictEqual(belowThresholdResults.length, 0, "Query with similarity below 0.5 should return 0 results");

      // Threshold > 1.0 (impossible for cosine similarity) returns 0 results
      const impossibleThresholdResults = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "pizza baking dough",
        minSimilarity: 1.01,
      });
      assert.strictEqual(impossibleThresholdResults.length, 0, "Threshold > 1.0 should return 0 results");

      console.log("✓ Similarity threshold controls inclusion and exclusion cleanly");
    }

    // -------------------------------------------------------------------------
    // TEST 5: Cross-user isolation
    // -------------------------------------------------------------------------
    console.log("[Test 5] Testing cross-user isolation and access boundaries...");
    {
      // 5a. User B attempting to search User A's conversation must throw 403 FORBIDDEN
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userB._id,
            conversationId: convA1._id,
            query: "TypeScript",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 403);
          assert.strictEqual(err.code, "FORBIDDEN");
          return true;
        },
        "User B cannot search User A's conversation"
      );

      // 5b. User B attempting to search User A's attachment directly must throw 403 FORBIDDEN
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userB._id,
            attachmentId: attA1._id,
            query: "TypeScript",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 403);
          assert.strictEqual(err.code, "FORBIDDEN");
          return true;
        },
        "User B cannot search User A's attachment"
      );

      // 5c. User A searching within User A scope never receives User B's documents
      const userAResults = await searchDocumentChunks({
        userId: userA._id,
        query: "TypeScript",
      });
      for (const r of userAResults) {
        assert.notStrictEqual(r.attachmentId, attB1._id.toString(), "User A must never receive User B chunks");
        assert.ok(!r.text.includes("User B confidential"));
      }

      // 5d. User B searching within User B scope only receives User B's documents
      const userBResults = await searchDocumentChunks({
        userId: userB._id,
        conversationId: convB1._id,
        query: "TypeScript",
      });
      assert.strictEqual(userBResults.length, 1);
      assert.strictEqual(userBResults[0]!.attachmentId, attB1._id.toString());

      console.log("✓ Cross-user isolation strictly verified with 403 rejections and clean scoping");
    }

    // -------------------------------------------------------------------------
    // TEST 6: Cross-conversation isolation
    // -------------------------------------------------------------------------
    console.log("[Test 6] Testing cross-conversation scoping and isolation...");
    {
      // 6a. Search scoped to Conv A1 must only return chunks from Doc A1, not Doc A2
      const convA1Results = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "TypeScript",
      });
      for (const r of convA1Results) {
        assert.strictEqual(r.attachmentId, attA1._id.toString(), "Must only return chunks from Conv A1");
        assert.notStrictEqual(r.attachmentId, attA2._id.toString(), "Must not return chunks from Conv A2");
      }

      // 6b. Search scoped to Conv A2 must only return chunks from Doc A2
      const convA2Results = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA2._id,
        query: "TypeScript",
      });
      assert.strictEqual(convA2Results.length, 1);
      assert.strictEqual(convA2Results[0]!.attachmentId, attA2._id.toString());

      // 6c. Invalid attachment/conversation mismatch:
      // Passing attA2._id with conversationId: convA1._id must throw 400 INVALID_ATTACHMENT_CONVERSATION
      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userA._id,
            conversationId: convA1._id,
            attachmentId: attA2._id,
            query: "TypeScript",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "INVALID_ATTACHMENT_CONVERSATION");
          return true;
        },
        "Attachment belonging to another conversation must be rejected"
      );

      console.log("✓ Cross-conversation isolation strictly enforced; conversation mismatch rejected with 400");
    }

    // -------------------------------------------------------------------------
    // TEST 7: Empty and no-result search handling
    // -------------------------------------------------------------------------
    console.log("[Test 7] Testing empty documents and no-result edge cases...");
    {
      // 7a. Search in empty conversation (Conv A3 has no documents)
      const resEmptyConv = await semanticDocumentSearch({
        userId: userA._id,
        conversationId: convA3._id,
        query: "TypeScript",
      });
      assert.strictEqual(resEmptyConv.success, true);
      assert.strictEqual(resEmptyConv.totalChunksSearched, 0);
      assert.strictEqual(resEmptyConv.results.length, 0);

      // 7b. Empty query string returns empty result cleanly
      const resEmptyQuery = await semanticDocumentSearch({
        userId: userA._id,
        conversationId: convA1._id,
        query: "   \t\n  ",
      });
      assert.strictEqual(resEmptyQuery.success, true);
      assert.strictEqual(resEmptyQuery.results.length, 0);

      // 7c. Query with no matching content above threshold
      const resNoMatch = await searchDocumentChunks({
        userId: userA._id,
        conversationId: convA1._id,
        query: "marathon fitness athletics", // Not present in Doc A1
        minSimilarity: 0.5,
      });
      assert.strictEqual(resNoMatch.length, 0);

      console.log("✓ Empty conversation, empty query, and non-matching query handled cleanly with 0 results");
    }

    // -------------------------------------------------------------------------
    // TEST 8: Embedding failure handling
    // -------------------------------------------------------------------------
    console.log("[Test 8] Testing embedding provider failure handling...");
    {
      const failingSearchProvider = new TestSearchEmbeddingProvider();
      failingSearchProvider.shouldFail = true;
      failingSearchProvider.failError = new AppError(
        "Embedding provider timeout during query vectorization",
        504,
        "AI_PROVIDER_TIMEOUT"
      );

      await assert.rejects(
        async () => {
          await searchDocumentChunks({
            userId: userA._id,
            conversationId: convA1._id,
            query: "TypeScript",
            provider: failingSearchProvider,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 504);
          assert.strictEqual(err.code, "AI_PROVIDER_TIMEOUT");
          return true;
        },
        "Provider failure must be cleanly surfaced as AppError"
      );

      console.log("✓ Provider failures during search safely handled and surfaced with proper HTTP status");
    }

    // -------------------------------------------------------------------------
    // TEST 9: Cosine similarity helper unit coverage
    // -------------------------------------------------------------------------
    console.log("[Test 9] Testing cosine similarity mathematical properties...");
    {
      // Identical vectors: similarity = 1.0
      const vec1 = [1, 2, 3];
      const vec2 = [1, 2, 3];
      const simIdentical = calculateCosineSimilarity(vec1, vec2);
      assert.ok(Math.abs(simIdentical - 1.0) < 1e-6);

      // Orthogonal vectors: similarity = 0.0
      const vecOrth1 = [1, 0, 0];
      const vecOrth2 = [0, 1, 0];
      const simOrth = calculateCosineSimilarity(vecOrth1, vecOrth2);
      assert.strictEqual(simOrth, 0);

      // Empty or invalid vectors: similarity = 0
      assert.strictEqual(calculateCosineSimilarity([], []), 0);
      assert.strictEqual(calculateCosineSimilarity([1, 2], [1, 2, 3]), 0);

      console.log("✓ Cosine similarity mathematical precision and boundary conditions verified");
    }

    console.log("\n=============================================================");
    console.log(" ALL 9 STEP 15 SEMANTIC DOCUMENT SEARCH TESTS PASSED SUCCESSFULLY ");
    console.log("=============================================================\n");
  } finally {
    // Restore default embedding provider
    setDefaultEmbeddingProvider(originalDefaultProvider);

    // Teardown test artifacts
    for (const attId of createdAttachmentIds) {
      await deleteDocumentChunksByAttachmentId(attId).catch(() => {});
      await Attachment.findByIdAndDelete(attId).catch(() => {});
    }
    for (const convId of createdConversationIds) {
      await Conversation.findByIdAndDelete(convId).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await User.findByIdAndDelete(userId).catch(() => {});
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
