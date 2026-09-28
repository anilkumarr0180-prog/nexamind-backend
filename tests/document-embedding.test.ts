import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import { DocumentChunk } from "../src/modules/attachments/document-chunk.model.js";
import {
  processDocumentEmbeddings,
  validateEmbeddingVector,
  setDefaultEmbeddingProvider,
  getDefaultEmbeddingProvider,
  createDocumentChunks,
  findDocumentChunksByAttachmentId,
  deleteDocumentChunksByAttachmentId,
  countDocumentChunksByAttachmentId,
  uploadDocumentAttachment,
  deleteAttachment,
} from "../src/modules/attachments/attachment.service.js";
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_STATUSES,
} from "../src/modules/attachments/attachment.types.js";
import { AppError } from "../src/errors/app.error.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";

/**
 * Deterministic test embedding provider
 */
class TestEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "test-document-embedding-provider";
  public dimensions: number = 768;
  public callCount = 0;
  public textsEmbedded: string[] = [];
  public shouldFail = false;
  public failError = new AppError("Simulated provider failure", 502, "AI_PROVIDER_ERROR");
  public customVectorGenerator?: (text: string) => number[];

  async generateEmbedding(text: string): Promise<number[]> {
    this.callCount++;
    this.textsEmbedded.push(text);

    if (this.shouldFail) {
      throw this.failError;
    }

    if (this.customVectorGenerator) {
      return this.customVectorGenerator(text);
    }

    const vector = new Array<number>(this.dimensions).fill(0.01);
    for (let i = 0; i < Math.min(text.length, this.dimensions); i++) {
      vector[i] = (text.charCodeAt(i) % 100) / 100;
    }
    return vector;
  }
}

const runTests = async () => {
  console.log("=== Starting Document Embeddings: Step 14 Automated Tests ===");

  await connectDatabase();

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  const originalDefaultProvider = getDefaultEmbeddingProvider();
  const mockProvider = new TestEmbeddingProvider();
  setDefaultEmbeddingProvider(mockProvider);

  try {
    // Setup test user & conversation
    const user = await User.create({
      name: "Embedding Test User",
      email: `embedding_user_${timestamp}@example.com`,
      passwordHash: "secure_hash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(user._id.toString());

    const conv = await Conversation.create({
      userId: user._id,
      title: "Document Embeddings Verification Conversation",
      status: "ACTIVE",
    });
    createdConversationIds.push(conv._id.toString());

    // -------------------------------------------------------------------------
    // TEST 1: One chunk embedding
    // -------------------------------------------------------------------------
    console.log("[Test 1] Testing single-chunk document embedding generation and storage...");
    {
      mockProvider.callCount = 0;
      mockProvider.textsEmbedded = [];

      const smallText = "NexaMind is an enterprise-grade AI assistant platform built with TypeScript.";
      const att1 = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "one-chunk.txt",
        mimeType: "text/plain",
        size: smallText.length,
        cloudinaryPublicId: `dummy_emb_1_${timestamp}`,
        secureUrl: "https://example.com/one-chunk.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: smallText,
        extractedTextLength: smallText.length,
      });
      createdAttachmentIds.push(att1._id.toString());

      const result = await processDocumentEmbeddings(att1._id);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attachmentId, att1._id.toString());
      assert.strictEqual(result.chunkCount, 1, "Expected exactly 1 chunk for small document");
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(mockProvider.callCount, 1, "Embedding provider should be called exactly once");

      // Verify stored record directly in MongoDB
      const storedChunks = await findDocumentChunksByAttachmentId(att1._id);
      assert.strictEqual(storedChunks.length, 1);
      const chunk = storedChunks[0]!;

      assert.strictEqual(chunk.attachmentId.toString(), att1._id.toString());
      assert.strictEqual(chunk.chunkIndex, 0);
      assert.strictEqual(chunk.text, smallText);
      assert.strictEqual(Array.isArray(chunk.embedding), true);
      assert.strictEqual(chunk.embedding.length, 768, "Stored vector must have 768 dimensions");
      assert.ok(chunk.createdAt instanceof Date, "Stored chunk must have createdAt timestamp");
      assert.ok(chunk.updatedAt instanceof Date, "Stored chunk must have updatedAt timestamp");

      // Verify attachment status remains READY
      const freshAtt = await Attachment.findById(att1._id);
      assert.ok(freshAtt);
      assert.strictEqual(freshAtt.status, ATTACHMENT_STATUSES.READY);

      console.log("✓ Single chunk embedding generated, validated, and persisted correctly");
    }

    // -------------------------------------------------------------------------
    // TEST 2: Multiple chunks with deterministic ordering
    // -------------------------------------------------------------------------
    console.log("[Test 2] Testing multi-chunk document embeddings with deterministic ordering...");
    {
      mockProvider.callCount = 0;
      mockProvider.textsEmbedded = [];

      const paragraphs: string[] = [
        "First section: Introduction to vector database indexation and mathematical embeddings in NexaMind.",
        "Second section: Document chunking divides large continuous text into semantically cohesive bounded tokens.",
        "Third section: High dimensional vector embeddings represent contextual relations across latent space.",
        "Fourth section: Deterministic chunk indices guarantee strict sequential reconstruction during search.",
      ];
      const multiDoc = paragraphs.join("\n\n");

      const att2 = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "multi-chunk.txt",
        mimeType: "text/plain",
        size: multiDoc.length,
        cloudinaryPublicId: `dummy_emb_2_${timestamp}`,
        secureUrl: "https://example.com/multi-chunk.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: multiDoc,
        extractedTextLength: multiDoc.length,
      });
      createdAttachmentIds.push(att2._id.toString());

      // Use a maxChunkSize of 140 to force 4 chunks
      const result = await processDocumentEmbeddings(att2._id, {
        chunkingOptions: { maxChunkSize: 140, chunkOverlap: 20 },
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.chunkCount >= 3, `Expected at least 3 chunks, got ${result.chunkCount}`);
      assert.strictEqual(mockProvider.callCount, result.chunkCount);

      // Verify records in MongoDB
      const storedChunks = await findDocumentChunksByAttachmentId(att2._id);
      assert.strictEqual(storedChunks.length, result.chunkCount);

      for (let i = 0; i < storedChunks.length; i++) {
        const sc = storedChunks[i]!;
        assert.strictEqual(sc.attachmentId.toString(), att2._id.toString());
        assert.strictEqual(sc.chunkIndex, i, `Chunk index must be strictly deterministic (${i})`);
        assert.ok(sc.text.length > 0, "Chunk text must not be empty");
        assert.strictEqual(sc.embedding.length, 768, "Each chunk must have 768-dim vector");
      }

      // First chunk includes first paragraph; last chunk includes last paragraph
      assert.ok(storedChunks[0]!.text.includes("First section"));
      assert.ok(storedChunks[storedChunks.length - 1]!.text.includes("Fourth section"));

      console.log(`✓ Multi-chunk document created ${storedChunks.length} deterministic chunks with 768-dim vectors`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Embedding dimension validation & rejection
    // -------------------------------------------------------------------------
    console.log("[Test 3] Testing embedding dimension validation and rejection...");
    {
      // 3a. Dimension mismatch (512 instead of 768)
      const wrongDimProvider = new TestEmbeddingProvider();
      wrongDimProvider.customVectorGenerator = () => new Array<number>(512).fill(0.1);

      const att3a = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "wrong-dim.txt",
        mimeType: "text/plain",
        size: 100,
        cloudinaryPublicId: `dummy_emb_3a_${timestamp}`,
        secureUrl: "https://example.com/wrong-dim.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: "Some text that triggers dimension validation mismatch check.",
        extractedTextLength: 60,
      });
      createdAttachmentIds.push(att3a._id.toString());

      await assert.rejects(
        async () => {
          await processDocumentEmbeddings(att3a._id, { provider: wrongDimProvider });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 502);
          assert.strictEqual(err.code, "INVALID_EMBEDDING_DIMENSIONS");
          assert.ok(err.message.includes("expected 768, got 512"));
          return true;
        },
        "Should reject vector with invalid dimensions"
      );

      // Verify attachment status is marked as FAILED in MongoDB
      const freshAtt3a = await Attachment.findById(att3a._id);
      assert.ok(freshAtt3a);
      assert.strictEqual(freshAtt3a.status, ATTACHMENT_STATUSES.FAILED);

      // Verify no partial chunks were stored in MongoDB
      const count3a = await countDocumentChunksByAttachmentId(att3a._id);
      assert.strictEqual(count3a, 0, "No chunks should be stored when dimension fails");

      // 3b. Non-numeric / NaN vector values
      const nanProvider = new TestEmbeddingProvider();
      nanProvider.customVectorGenerator = () => {
        const v = new Array<number>(768).fill(0.1);
        v[5] = NaN;
        return v;
      };

      const att3b = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "nan-vector.txt",
        mimeType: "text/plain",
        size: 100,
        cloudinaryPublicId: `dummy_emb_3b_${timestamp}`,
        secureUrl: "https://example.com/nan-vector.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: "Text that produces a NaN vector.",
        extractedTextLength: 32,
      });
      createdAttachmentIds.push(att3b._id.toString());

      await assert.rejects(
        async () => {
          await processDocumentEmbeddings(att3b._id, { provider: nanProvider });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.code, "INVALID_EMBEDDING_VECTOR");
          return true;
        },
        "Should reject vector containing NaN"
      );

      const freshAtt3b = await Attachment.findById(att3b._id);
      assert.strictEqual(freshAtt3b?.status, ATTACHMENT_STATUSES.FAILED);
      const count3b = await countDocumentChunksByAttachmentId(att3b._id);
      assert.strictEqual(count3b, 0);

      // 3c. Direct validateEmbeddingVector unit checks
      assert.throws(() => validateEmbeddingVector([], 768));
      assert.throws(() => validateEmbeddingVector([1, 2, 3], 768));
      // @ts-expect-error test non-array
      assert.throws(() => validateEmbeddingVector("not-an-array", 768));
      assert.doesNotThrow(() => validateEmbeddingVector(new Array(768).fill(0.5), 768));

      console.log("✓ Inconsistent dimensions and invalid vectors strictly rejected and marked FAILED");
    }

    // -------------------------------------------------------------------------
    // TEST 4: Duplicate & reprocessing protection (Idempotency)
    // -------------------------------------------------------------------------
    console.log("[Test 4] Testing duplicate and reprocessing protection (idempotency)...");
    {
      const repeatedDoc = [
        "Chunk Alpha: Document embeddings enable deep semantic search across conversations.",
        "Chunk Beta: Each chunk is deterministically indexed and bounded to prevent token explosion.",
        "Chunk Gamma: Reprocessing an attachment must replace previous chunks without duplicating records.",
      ].join("\n\n");

      const att4 = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "idempotency.txt",
        mimeType: "text/plain",
        size: repeatedDoc.length,
        cloudinaryPublicId: `dummy_emb_4_${timestamp}`,
        secureUrl: "https://example.com/idempotency.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: repeatedDoc,
        extractedTextLength: repeatedDoc.length,
      });
      createdAttachmentIds.push(att4._id.toString());

      // First run
      const run1 = await processDocumentEmbeddings(att4._id, {
        chunkingOptions: { maxChunkSize: 120, chunkOverlap: 20 },
      });
      const initialCount = await countDocumentChunksByAttachmentId(att4._id);
      assert.ok(initialCount >= 2, `Expected at least 2 chunks, got ${initialCount}`);
      assert.strictEqual(run1.chunkCount, initialCount);

      // Second run (reprocessing the exact same attachment)
      const run2 = await processDocumentEmbeddings(att4._id, {
        chunkingOptions: { maxChunkSize: 120, chunkOverlap: 20 },
      });
      const secondCount = await countDocumentChunksByAttachmentId(att4._id);

      assert.strictEqual(
        secondCount,
        initialCount,
        `Reprocessing must not create duplicate chunks (expected ${initialCount}, got ${secondCount})`
      );
      assert.strictEqual(run2.chunkCount, initialCount);

      // Third run
      await processDocumentEmbeddings(att4._id, {
        chunkingOptions: { maxChunkSize: 120, chunkOverlap: 20 },
      });
      const thirdCount = await countDocumentChunksByAttachmentId(att4._id);
      assert.strictEqual(thirdCount, initialCount);

      // Verify unique compound index constraint at Mongoose/MongoDB level
      await assert.rejects(
        async () => {
          await DocumentChunk.create({
            attachmentId: att4._id,
            chunkIndex: 0, // Duplicate (attachmentId, chunkIndex)
            text: "Duplicate chunk attempt",
            embedding: new Array(768).fill(0.1),
          });
        },
        /duplicate key|E11000/i,
        "Database unique index must prevent duplicate (attachmentId, chunkIndex)"
      );

      console.log("✓ Full idempotency and duplicate prevention verified across multiple re-runs");
    }

    // -------------------------------------------------------------------------
    // TEST 5: Provider failure handling safely marks attachment FAILED
    // -------------------------------------------------------------------------
    console.log("[Test 5] Testing provider failure handling and status transition...");
    {
      const failingProvider = new TestEmbeddingProvider();
      failingProvider.shouldFail = true;
      failingProvider.failError = new AppError("Ollama Embed API timed out", 504, "AI_PROVIDER_TIMEOUT");

      const att5 = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "failing-provider.txt",
        mimeType: "text/plain",
        size: 80,
        cloudinaryPublicId: `dummy_emb_5_${timestamp}`,
        secureUrl: "https://example.com/failing-provider.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: "Text intended to trigger provider failure handling.",
        extractedTextLength: 51,
      });
      createdAttachmentIds.push(att5._id.toString());

      await assert.rejects(
        async () => {
          await processDocumentEmbeddings(att5._id, { provider: failingProvider });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 504);
          assert.strictEqual(err.code, "AI_PROVIDER_TIMEOUT");
          return true;
        }
      );

      // Verify attachment status is FAILED in MongoDB
      const freshAtt5 = await Attachment.findById(att5._id);
      assert.ok(freshAtt5);
      assert.strictEqual(
        freshAtt5.status,
        ATTACHMENT_STATUSES.FAILED,
        "Attachment status must be updated to FAILED when embedding fails"
      );

      // Verify no orphaned chunks
      const chunkCount5 = await countDocumentChunksByAttachmentId(att5._id);
      assert.strictEqual(chunkCount5, 0, "No chunks should remain on failure");

      // Verify that calling processDocumentEmbeddings on an attachment with status FAILED rejects
      await assert.rejects(
        async () => {
          await processDocumentEmbeddings(att5._id);
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, "ATTACHMENT_NOT_READY");
          return true;
        },
        "Processing a non-READY attachment must be rejected"
      );

      console.log("✓ Provider failures safely caught, attachment marked FAILED, partial chunks cleaned");
    }

    // -------------------------------------------------------------------------
    // TEST 6: Empty document handling
    // -------------------------------------------------------------------------
    console.log("[Test 6] Testing empty and whitespace-only documents...");
    {
      const provider6 = new TestEmbeddingProvider();

      // 6a. Empty string
      const att6a = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "empty.txt",
        mimeType: "text/plain",
        size: 1,
        cloudinaryPublicId: `dummy_emb_6a_${timestamp}`,
        secureUrl: "https://example.com/empty.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: "",
        extractedTextLength: 0,
      });
      createdAttachmentIds.push(att6a._id.toString());

      const res6a = await processDocumentEmbeddings(att6a._id, { provider: provider6 });
      assert.strictEqual(res6a.success, true);
      assert.strictEqual(res6a.chunkCount, 0);
      assert.deepStrictEqual(res6a.chunks, []);
      assert.strictEqual(provider6.callCount, 0, "Provider should not be called for empty document");

      const count6a = await countDocumentChunksByAttachmentId(att6a._id);
      assert.strictEqual(count6a, 0);
      const freshAtt6a = await Attachment.findById(att6a._id);
      assert.strictEqual(freshAtt6a?.status, ATTACHMENT_STATUSES.READY);

      // 6b. Whitespace-only string
      const att6b = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "whitespace.txt",
        mimeType: "text/plain",
        size: 15,
        cloudinaryPublicId: `dummy_emb_6b_${timestamp}`,
        secureUrl: "https://example.com/whitespace.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: "   \n\n\t  \r\n  ",
        extractedTextLength: 15,
      });
      createdAttachmentIds.push(att6b._id.toString());

      const res6b = await processDocumentEmbeddings(att6b._id, { provider: provider6 });
      assert.strictEqual(res6b.success, true);
      assert.strictEqual(res6b.chunkCount, 0);
      assert.strictEqual(provider6.callCount, 0);

      console.log("✓ Empty and whitespace documents handled safely without calling provider or creating chunks");
    }

    // -------------------------------------------------------------------------
    // TEST 7: Existing document upload flow remains working
    // -------------------------------------------------------------------------
    console.log("[Test 7] Testing existing document upload flow and attachment lifecycle...");
    {
      const txtContent = "Testing existing document upload pipeline backwards compatibility.";
      const uploadResult = await uploadDocumentAttachment({
        userId: user._id.toString(),
        conversationId: conv._id.toString(),
        file: Buffer.from(txtContent, "utf-8"),
        originalName: "compat-test.txt",
        mimeType: "text/plain",
        size: txtContent.length,
      });

      assert.ok(uploadResult.attachmentId);
      assert.strictEqual(uploadResult.type, "DOCUMENT");
      assert.strictEqual(uploadResult.originalName, "compat-test.txt");
      assert.strictEqual(uploadResult.status, "READY");
      assert.strictEqual(uploadResult.extractedTextLength, txtContent.length);
      createdAttachmentIds.push(uploadResult.attachmentId);

      // Now process embeddings on the uploaded document
      const embRes = await processDocumentEmbeddings(uploadResult.attachmentId);
      assert.strictEqual(embRes.success, true);
      assert.strictEqual(embRes.chunkCount, 1);

      const chunkCountBeforeDelete = await countDocumentChunksByAttachmentId(uploadResult.attachmentId);
      assert.strictEqual(chunkCountBeforeDelete, 1);

      // Test lifecycle: deleting attachment also cleans up chunk embeddings
      const delRes = await deleteAttachment(uploadResult.attachmentId, user._id.toString());
      assert.strictEqual(delRes.deleted, true);

      const chunkCountAfterDelete = await countDocumentChunksByAttachmentId(uploadResult.attachmentId);
      assert.strictEqual(chunkCountAfterDelete, 0, "Document chunks must be cleaned up when attachment is deleted");

      // Test upload with generateEmbeddings: true
      const uploadWithEmbResult = await uploadDocumentAttachment({
        userId: user._id.toString(),
        conversationId: conv._id.toString(),
        file: Buffer.from("Document uploaded with auto-embedding enabled.", "utf-8"),
        originalName: "auto-emb.txt",
        mimeType: "text/plain",
        size: 44,
        generateEmbeddings: true,
      });

      assert.strictEqual(uploadWithEmbResult.status, "READY");
      createdAttachmentIds.push(uploadWithEmbResult.attachmentId);

      const autoChunks = await findDocumentChunksByAttachmentId(uploadWithEmbResult.attachmentId);
      assert.strictEqual(autoChunks.length, 1);
      assert.strictEqual(autoChunks[0]!.embedding.length, 768);

      console.log("✓ Existing document upload flow remains fully working with optional auto-embedding & cleanup");
    }

    console.log("\n=========================================================");
    console.log(" ALL 7 STEP 14 DOCUMENT EMBEDDINGS TESTS PASSED SUCCESSFULLY ");
    console.log("=========================================================\n");
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
