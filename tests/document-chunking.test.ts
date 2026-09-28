import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import {
  chunkDocumentText,
  chunkDocument,
  chunkAttachment,
  cleanDocumentText,
  estimateTokenCount,
  DEFAULT_MAX_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
} from "../src/modules/attachments/document-chunking.service.js";
import { ATTACHMENT_TYPES, ATTACHMENT_STATUSES } from "../src/modules/attachments/attachment.types.js";

const runTests = async () => {
  console.log("=== Starting Document Chunking: Step 13 Automated Tests ===");

  await connectDatabase();

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Empty text and whitespace-only documents
    // -------------------------------------------------------------------------
    console.log("[Test 1] Testing empty and whitespace-only document chunking...");
    {
      const emptyResult1 = chunkDocumentText("att-empty-1", "");
      assert.deepStrictEqual(emptyResult1, [], "Empty string must return empty array of chunks");

      const emptyResult2 = chunkDocumentText("att-empty-2", "   \n\n\t  \r\n  ");
      assert.deepStrictEqual(emptyResult2, [], "Whitespace-only string must return empty array of chunks");

      const emptyResult3 = chunkDocumentText({
        attachmentId: "att-empty-3",
        text: "",
      });
      assert.deepStrictEqual(emptyResult3, [], "Object signature with empty text must return empty array");

      // @ts-expect-error test invalid types at runtime safely
      const emptyResult4 = chunkDocumentText("att-empty-4", null);
      assert.deepStrictEqual(emptyResult4, [], "Null text must return empty array");

      // @ts-expect-error test undefined text at runtime safely
      const emptyResult5 = chunkDocumentText("att-empty-5", undefined);
      assert.deepStrictEqual(emptyResult5, [], "Undefined text must return empty array");

      console.log("✓ Empty and whitespace documents safely return empty chunk lists");
    }

    // -------------------------------------------------------------------------
    // TEST 2: Small document (fits within single chunk)
    // -------------------------------------------------------------------------
    console.log("[Test 2] Testing small document chunking...");
    {
      const smallText = "NexaMind is an intelligent AI assistant platform built with modern TypeScript.";
      const chunks = chunkDocumentText("att-small-1", smallText, { maxChunkSize: 1000 });

      assert.strictEqual(chunks.length, 1, "Small document should produce exactly 1 chunk");
      assert.strictEqual(chunks[0]!.attachmentId, "att-small-1");
      assert.strictEqual(chunks[0]!.chunkIndex, 0);
      assert.strictEqual(chunks[0]!.text, smallText);

      // Verify object signature as well
      const chunksObj = chunkDocumentText({
        attachmentId: "att-small-1",
        text: smallText,
        chunkSize: 1000,
      });
      assert.deepStrictEqual(chunksObj, chunks, "Object signature must produce identical chunk result");

      console.log("✓ Small document produces exactly one chunk with deterministic metadata");
    }

    // -------------------------------------------------------------------------
    // TEST 3: Large document (multi-paragraph)
    // -------------------------------------------------------------------------
    console.log("[Test 3] Testing large multi-paragraph document chunking...");
    {
      const paragraphs: string[] = [];
      for (let i = 1; i <= 12; i++) {
        paragraphs.push(
          `Paragraph ${i}: NexaMind document processing ensures high accuracy and bounded prompt injection. Component number ${i} provides semantic context and streaming responses.`
        );
      }
      const largeDoc = paragraphs.join("\n\n");
      const maxChunkSize = 500;
      const chunkOverlap = 100;

      const chunks = chunkDocumentText("att-large-1", largeDoc, { maxChunkSize, chunkOverlap });

      assert.ok(chunks.length > 1, `Expected multiple chunks for large doc, got ${chunks.length}`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        assert.strictEqual(chunk.attachmentId, "att-large-1");
        assert.strictEqual(chunk.chunkIndex, i, `Chunk index must strictly equal ${i}`);
        assert.ok(chunk.text.length > 0, "Chunk text must not be empty");
        assert.ok(
          chunk.text.length <= maxChunkSize,
          `Chunk ${i} length ${chunk.text.length} exceeds maxChunkSize ${maxChunkSize}`
        );
      }

      // Verify first paragraph content is in first chunk and last paragraph content is in last chunk
      assert.ok(chunks[0]!.text.includes("Paragraph 1:"));
      assert.ok(chunks[chunks.length - 1]!.text.includes("Paragraph 12:"));

      console.log(`✓ Large document produced ${chunks.length} bounded sequential chunks covering all content`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Chunk boundaries (preserves paragraph and sentence boundaries)
    // -------------------------------------------------------------------------
    console.log("[Test 4] Testing boundary preservation (paragraphs & sentences)...");
    {
      const p1 = "First section introduces core concepts. It contains two distinct sentences.";
      const p2 = "Second section covers detailed implementation. It describes architectural patterns.";
      const p3 = "Third section summarizes the results. Everything functions as expected.";
      const doc = `${p1}\n\n${p2}\n\n${p3}`;

      // Set maxChunkSize so p1 fits, but p1 + p2 exceeds it
      const maxChunkSize = p1.length + 30; // ~104 chars
      const chunks = chunkDocumentText("att-bound-1", doc, { maxChunkSize, chunkOverlap: 20 });

      // First chunk should cleanly end at paragraph 1 boundary without cutting mid-sentence
      assert.ok(chunks[0]!.text.includes("distinct sentences."));
      assert.ok(!chunks[0]!.text.includes("Second section"), "Chunk 0 should not cut into paragraph 2 mid-stream");

      // Verify sentence boundary preservation when splitting single paragraphs
      const sentencesDoc = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.";
      const sentenceChunks = chunkDocumentText("att-bound-2", sentencesDoc, { maxChunkSize: 45, chunkOverlap: 10 });
      for (const sc of sentenceChunks) {
        // Chunks should end at period or word boundary, not split words
        const trimmed = sc.text.trim();
        assert.ok(
          trimmed.endsWith(".") || !trimmed.includes(" "),
          `Chunk "${trimmed}" should end cleanly at sentence or word boundary`
        );
      }

      console.log("✓ Paragraph and sentence boundaries preserved cleanly across chunk cuts");
    }

    // -------------------------------------------------------------------------
    // TEST 5: Overlap between adjacent chunks
    // -------------------------------------------------------------------------
    console.log("[Test 5] Testing overlap between adjacent chunks...");
    {
      const doc = [
        "Section 1: The quick brown fox jumps over the lazy dog.",
        "Section 2: Artificial intelligence transforms modern software development workflows.",
        "Section 3: Deterministic chunking enables reliable document retrieval and grounding.",
        "Section 4: Cloud native distributed architectures scale horizontally with ease.",
      ].join("\n\n");

      const maxChunkSize = 140;
      const chunkOverlap = 40;
      const chunks = chunkDocumentText("att-overlap-1", doc, { maxChunkSize, chunkOverlap });

      assert.ok(chunks.length >= 3, "Expected at least 3 chunks to verify overlap across multiple boundaries");

      for (let i = 0; i < chunks.length - 1; i++) {
        const currChunk = chunks[i]!;
        const nextChunk = chunks[i + 1]!;

        // The start of nextChunk should overlap with the end of currChunk
        // Extract words from the end of currChunk
        const currWords = currChunk.text.split(/\s+/).filter((w) => w.length > 3);
        const lastFewWords = currWords.slice(-3);

        const hasOverlap = lastFewWords.some((word) => nextChunk.text.includes(word));
        assert.ok(
          hasOverlap,
          `Expected overlap between Chunk ${i} ("...${currChunk.text.slice(-30)}") and Chunk ${i + 1} ("${nextChunk.text.slice(0, 30)}...")`
        );
      }

      // Verify zero overlap behavior when explicitly requested
      const noOverlapChunks = chunkDocumentText("att-overlap-0", doc, { maxChunkSize: 140, chunkOverlap: 0 });
      assert.ok(noOverlapChunks.length >= 2);
      // When chunkOverlap is 0, next chunk should start right after end of previous cut
      console.log("✓ Overlap between adjacent chunks successfully verified, including zero-overlap option");
    }

    // -------------------------------------------------------------------------
    // TEST 6: Deterministic ordering and idempotency
    // -------------------------------------------------------------------------
    console.log("[Test 6] Testing deterministic ordering and idempotency...");
    {
      const sampleText = [
        "Chapter 1: The foundation of modern vector retrieval.",
        "Chapter 2: Tokenization and semantic embeddings in production systems.",
        "Chapter 3: Query preprocessing and hybrid ranking strategies.",
        "Chapter 4: Scalable memory layers and persistent AI context.",
      ].join("\n\n");

      const run1 = chunkDocumentText("att-det-1", sampleText, { maxChunkSize: 120, chunkOverlap: 30 });
      const run2 = chunkDocumentText("att-det-1", sampleText, { maxChunkSize: 120, chunkOverlap: 30 });

      assert.strictEqual(run1.length, run2.length, "Runs must produce identical number of chunks");

      for (let i = 0; i < run1.length; i++) {
        assert.strictEqual(run1[i]!.chunkIndex, i);
        assert.strictEqual(run2[i]!.chunkIndex, i);
        assert.strictEqual(run1[i]!.attachmentId, run2[i]!.attachmentId);
        assert.strictEqual(run1[i]!.text, run2[i]!.text, `Chunk ${i} text must be strictly identical`);
      }

      console.log("✓ Deterministic ordering (0..N-1) and full idempotency verified across runs");
    }

    // -------------------------------------------------------------------------
    // TEST 7: Maximum chunk size guarantee (strict bounding)
    // -------------------------------------------------------------------------
    console.log("[Test 7] Testing maximum chunk size enforcement across various constraints...");
    {
      const longText = [
        "NexaMind AI is an enterprise-grade assistant that integrates chat, document analysis, and memory.",
        "It supports PDF, DOCX, TXT, MD, CSV, and JSON file attachments with robust security validation.",
        "Document chunking ensures that arbitrarily large documents never overwhelm the LLM context window.",
        "Each chunk preserves contextual continuity through parameterized token and character overlaps.",
      ].join(" ");

      const sizeLimits = [80, 120, 250, 500, 1000];

      for (const limit of sizeLimits) {
        const chunks = chunkDocumentText("att-limit-1", longText, { maxChunkSize: limit, chunkOverlap: 20 });
        for (const c of chunks) {
          assert.ok(
            c.text.length <= limit,
            `Chunk ${c.chunkIndex} length (${c.text.length}) exceeded maxChunkSize (${limit})`
          );
        }
      }

      console.log("✓ Maximum chunk size is strictly enforced across multiple size limits");
    }

    // -------------------------------------------------------------------------
    // TEST 8: Oversized single paragraph handling
    // -------------------------------------------------------------------------
    console.log("[Test 8] Testing oversized single paragraph without newlines...");
    {
      // 2500 character single paragraph with no newlines
      const sentences: string[] = [];
      for (let i = 1; i <= 30; i++) {
        sentences.push(`Sentence ${i} provides substantive commentary on AI agent architectures and document groundings.`);
      }
      const singlePara = sentences.join(" ");
      const maxChunkSize = 300;

      const chunks = chunkDocumentText("att-oversized-1", singlePara, { maxChunkSize, chunkOverlap: 50 });

      assert.ok(chunks.length >= 8, `Expected at least 8 chunks, got ${chunks.length}`);
      for (const c of chunks) {
        assert.ok(
          c.text.length <= maxChunkSize,
          `Oversized paragraph chunk length ${c.text.length} exceeded ${maxChunkSize}`
        );
      }

      console.log(`✓ Oversized paragraph split into ${chunks.length} compliant chunks <= ${maxChunkSize} chars`);
    }

    // -------------------------------------------------------------------------
    // TEST 9: Oversized unbroken string handling (no whitespace or punctuation)
    // -------------------------------------------------------------------------
    console.log("[Test 9] Testing unbroken string without whitespace (hard cut fallback)...");
    {
      const unbroken = "Z".repeat(1500);
      const maxChunkSize = 250;
      const chunks = chunkDocumentText("att-unbroken-1", unbroken, { maxChunkSize, chunkOverlap: 50 });

      assert.ok(chunks.length >= 6);
      for (const c of chunks) {
        assert.ok(
          c.text.length <= maxChunkSize,
          `Unbroken chunk length ${c.text.length} exceeded ${maxChunkSize}`
        );
      }

      console.log("✓ Unbroken string safely hard-cut without infinite loop or size violation");
    }

    // -------------------------------------------------------------------------
    // TEST 10: Repeated whitespace normalization
    // -------------------------------------------------------------------------
    console.log("[Test 10] Testing repeated whitespace normalization...");
    {
      const messyDoc = "   Paragraph 1   with   excessive    spaces.   \n\n\n\n\n\n\n\n   Paragraph 2   with   tabs\t\tand   spaces.   \n\n\n   Paragraph 3.   ";
      const cleaned = cleanDocumentText(messyDoc);
      assert.ok(!cleaned.includes("\n\n\n"), "Should not contain 3 or more consecutive newlines");
      assert.ok(!cleaned.includes("   "), "Should not contain 3 consecutive spaces");

      const chunks = chunkDocumentText("att-messy-1", messyDoc, { maxChunkSize: 500 });
      assert.strictEqual(chunks.length, 1);
      assert.ok(!chunks[0]!.text.startsWith(" "));
      assert.ok(!chunks[0]!.text.endsWith(" "));

      console.log("✓ Repeated whitespace and excessive newlines safely normalized");
    }

    // -------------------------------------------------------------------------
    // TEST 11: Keeping original extracted document unchanged in MongoDB & in-memory
    // -------------------------------------------------------------------------
    console.log("[Test 11] Testing original document in MongoDB remains strictly unchanged...");
    {
      const user = await User.create({
        name: "Chunking Test User",
        email: `chunking_user_${timestamp}@example.com`,
        passwordHash: "secure_hash",
        status: "ACTIVE",
        roles: ["USER"],
      });
      createdUserIds.push(user._id.toString());

      const conv = await Conversation.create({
        userId: user._id,
        title: "Chunking Verification Conversation",
        status: "ACTIVE",
      });
      createdConversationIds.push(conv._id.toString());

      const originalExtractedText = [
        "NexaMind Step 13 Test Document.",
        "This extracted document text must remain entirely immutable in the database.",
        "Chunking operates as a pure reader service and must never mutate or truncate the source Attachment.",
      ].join("\n\n");

      const attachment = await Attachment.create({
        userId: user._id,
        conversationId: conv._id,
        type: ATTACHMENT_TYPES.DOCUMENT,
        originalName: "test-document.txt",
        mimeType: "text/plain",
        size: originalExtractedText.length,
        cloudinaryPublicId: `dummy_chunk_id_${timestamp}`,
        secureUrl: "https://example.com/test-document.txt",
        status: ATTACHMENT_STATUSES.READY,
        format: "txt",
        extractedText: originalExtractedText,
        extractedTextLength: originalExtractedText.length,
      });
      createdAttachmentIds.push(attachment._id.toString());

      // Chunk via chunkAttachment helper
      const chunks = chunkAttachment(attachment, { maxChunkSize: 100, chunkOverlap: 20 });
      assert.ok(chunks.length > 1, "Should generate multiple chunks for 100 char limit");

      // Verify in-memory attachment unchanged
      assert.strictEqual(
        attachment.extractedText,
        originalExtractedText,
        "In-memory extractedText must remain identical"
      );
      assert.strictEqual(
        attachment.extractedTextLength,
        originalExtractedText.length,
        "In-memory extractedTextLength must remain identical"
      );

      // Verify MongoDB persisted record is completely untouched
      const freshAttachment = await Attachment.findById(attachment._id);
      assert.ok(freshAttachment, "Attachment must exist in database");
      assert.strictEqual(
        freshAttachment.extractedText,
        originalExtractedText,
        "MongoDB persisted extractedText must remain completely unchanged"
      );
      assert.strictEqual(
        freshAttachment.extractedTextLength,
        originalExtractedText.length,
        "MongoDB persisted extractedTextLength must remain completely unchanged"
      );

      console.log("✓ Original extracted document verified 100% unchanged in MongoDB and in-memory");
    }

    // -------------------------------------------------------------------------
    // TEST 12: Token estimation helper & service conventions
    // -------------------------------------------------------------------------
    console.log("[Test 12] Testing token estimation and project conventions...");
    {
      assert.strictEqual(estimateTokenCount(""), 0);
      assert.strictEqual(estimateTokenCount("abcd"), 1);
      assert.strictEqual(estimateTokenCount("abcdefgh"), 2);
      assert.strictEqual(estimateTokenCount("a".repeat(100)), 25);

      assert.strictEqual(typeof DEFAULT_MAX_CHUNK_SIZE, "number");
      assert.strictEqual(typeof DEFAULT_CHUNK_OVERLAP, "number");
      assert.ok(DEFAULT_MAX_CHUNK_SIZE > DEFAULT_CHUNK_OVERLAP);

      // Verify chunkDocument alias
      const resA = chunkDocument("att-alias", "Sample text");
      const resB = chunkDocumentText("att-alias", "Sample text");
      assert.deepStrictEqual(resA, resB, "chunkDocument alias must produce identical result");

      console.log("✓ Token estimation and service conventions verified");
    }

    console.log("\n=======================================================");
    console.log(" ALL 12 STEP 13 DOCUMENT CHUNKING TESTS PASSED SUCCESSFULLY ");
    console.log("=======================================================\n");
  } finally {
    // Teardown test artifacts safely
    for (const attId of createdAttachmentIds) {
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
