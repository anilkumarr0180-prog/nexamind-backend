import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Types } from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import { DocumentChunk } from "../src/modules/attachments/document-chunk.model.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import {
  validateImageMetadata,
  validateImageContent,
  validateDocumentMetadata,
  extractDocumentText,
  getAttachmentById,
  deleteAttachment,
  cleanupAttachmentIfOrphaned,
  verifyAttachmentForMessage,
  processDocumentEmbeddings,
  semanticDocumentSearch,
  chunkDocumentText,
  setDefaultEmbeddingProvider,
  getDefaultEmbeddingProvider,
} from "../src/modules/attachments/attachment.service.js";
import { formatRagDocumentContext } from "../src/modules/ai/context-builder.service.js";
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_STATUSES,
  MAX_ATTACHMENT_FILE_SIZE,
  MAX_DOCUMENT_FILE_SIZE,
  MAX_DOCUMENT_EXTRACTED_CHARS,
  MAX_DOCUMENT_CHUNKS,
  MAX_RAG_TOP_K,
} from "../src/modules/attachments/attachment.types.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../src/modules/ai/providers/embedding-provider.interface.js";
import { AppError } from "../src/errors/app.error.js";

/**
 * Deterministic Mock AI Provider
 */
class MockHardeningAIProvider implements AIProvider {
  public readonly name = "mock-hardening-ai-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: "Hardened response generated cleanly.",
      provider: "mock-hardening-ai-provider",
      model: "test-model",
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
    };
  }
}

/**
 * Deterministic Mock Embedding Provider
 */
class MockHardeningEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-hardening-embedding-provider";
  public readonly dimensions: number = 768;

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();
    if (lower.includes("security") || lower.includes("hardening")) {
      vector[0] = 0.92;
      vector[1] = 0.35;
    } else if (lower.includes("architecture")) {
      vector[10] = 0.95;
      vector[11] = 0.25;
    }
    return vector;
  }
}

/**
 * Failing Embedding Provider for testing failure resilience
 */
class MockFailingEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-failing-embedding-provider";
  public readonly dimensions: number = 768;

  async generateEmbedding(_text: string): Promise<number[]> {
    throw new AppError("Simulated Ollama embedding engine timeout", 502, "AI_PROVIDER_ERROR");
  }
}

const runTests = async () => {
  console.log("=== Starting Step 18: Production Hardening Regression Suite ===");

  await connectDatabase();
  const originalEmbeddingProvider = getDefaultEmbeddingProvider();
  const testEmbeddingProvider = new MockHardeningEmbeddingProvider();
  setDefaultEmbeddingProvider(testEmbeddingProvider);

  const mockAiProvider = new MockHardeningAIProvider();
  orchestratorService.setDefaultProvider(mockAiProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${address.port}`;

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Setup Users and Conversations
    // -------------------------------------------------------------
    const userA = await User.create({
      email: `hardened_user_a_${timestamp}@example.com`,
      passwordHash: "hash_a",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    await TokenBalance.create({ userId: userA._id, balance: 100 });

    const userB = await User.create({
      email: `hardened_user_b_${timestamp}@example.com`,
      passwordHash: "hash_b",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    await TokenBalance.create({ userId: userB._id, balance: 100 });

    const convA = await Conversation.create({
      userId: userA._id,
      title: `User A Hardening Conversation ${timestamp}`,
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });
    createdConversationIds.push(convA._id.toString());

    const convB = await Conversation.create({
      userId: userB._id,
      title: `User B Hardening Conversation ${timestamp}`,
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });
    createdConversationIds.push(convB._id.toString());

    // Create an attachment for User A
    const attachmentA = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "security-audit.txt",
      mimeType: "text/plain",
      size: 1024,
      cloudinaryPublicId: `nexamind/test_hardening_a_${timestamp}`,
      secureUrl: "https://res.cloudinary.com/nexamind/raw/upload/test_a.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: "Critical security hardening rules: verify authentication and bound retrieval.",
      extractedTextLength: 78,
    });
    createdAttachmentIds.push(attachmentA._id.toString());

    // Generate embeddings for User A's document
    await processDocumentEmbeddings(attachmentA, { provider: testEmbeddingProvider });

    // -------------------------------------------------------------
    // 1. Cross-User Access Isolation Tests
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing cross-user access isolation...");

    // 1a. User B searching without passing attachmentId should NOT find User A's document chunks
    const searchResultUserB = await semanticDocumentSearch({
      userId: userB._id.toString(),
      conversationId: convB._id.toString(),
      query: "security hardening",
      provider: testEmbeddingProvider,
    });
    assert.equal(
      searchResultUserB.results.length,
      0,
      "User B must never retrieve User A's document chunks in their search",
    );

    // 1b. User B explicitly targeting User A's attachmentId must be rejected with 403 FORBIDDEN
    try {
      await semanticDocumentSearch({
        userId: userB._id.toString(),
        conversationId: convB._id.toString(),
        attachmentId: attachmentA._id.toString(),
        query: "security hardening",
        provider: testEmbeddingProvider,
      });
      assert.fail("Targeting another user's attachmentId must throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    // 1c. User B attempting to read User A's attachment by ID throws 403 FORBIDDEN
    try {
      await getAttachmentById(attachmentA._id.toString(), userB._id.toString());
      assert.fail("getAttachmentById for another user must throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    // 1d. User B attempting to delete User A's attachment throws 403 FORBIDDEN
    try {
      await deleteAttachment(attachmentA._id.toString(), userB._id.toString());
      assert.fail("deleteAttachment for another user must throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    // 1e. User B attempting to attach User A's attachment to User B's conversation throws 403 FORBIDDEN
    try {
      await verifyAttachmentForMessage(
        attachmentA._id.toString(),
        userB._id.toString(),
        convB._id.toString(),
      );
      assert.fail("verifyAttachmentForMessage for another user must throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    console.log("✓ Cross-user access isolation strictly enforced across all operations (403 FORBIDDEN)");

    // -------------------------------------------------------------
    // 2. Malicious / Invalid Files & Extension Spoofing Tests
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing malicious/invalid files & extension spoofing protection...");

    // 2a. Windows PE executable header ('MZ') spoofed as image
    const peBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    try {
      validateImageContent(peBuffer, ".jpg");
      assert.fail("Executable spoofed as JPEG must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_IMAGE_CONTENT");
    }

    // 2b. Linux ELF executable header ('\x7fELF') spoofed as PNG
    const elfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
    try {
      validateImageContent(elfBuffer, ".png");
      assert.fail("ELF binary spoofed as PNG must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_IMAGE_CONTENT");
    }

    // 2c. Valid PNG passes magic bytes check
    const validPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    assert.doesNotThrow(() => {
      validateImageContent(validPngBuffer, ".png");
    }, "Valid PNG magic bytes must pass without error");

    // 2d. Spoofed DOCX (plain text named .docx missing PK\x03\x04 header)
    try {
      await extractDocumentText(Buffer.from("This is plain text pretending to be docx"), ".docx");
      assert.fail("DOCX missing PK zip header must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_DOCX");
    }

    // 2e. Spoofed PDF (plain text named .pdf missing %PDF- header)
    try {
      await extractDocumentText(Buffer.from("This is plain text pretending to be pdf"), ".pdf");
      assert.fail("PDF missing %PDF- header must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_PDF");
    }

    // 2f. Executable binary disguised as plain text
    try {
      await extractDocumentText(peBuffer, ".txt");
      assert.fail("Executable binary disguised as TXT must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "TEXT_EXTRACTION_FAILED");
    }

    // 2g. Invalid JSON in .json document
    try {
      await extractDocumentText("{ invalid json: missing quotes }", ".json");
      assert.fail("Invalid JSON document must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_JSON");
    }

    console.log("✓ Extension spoofing and malicious binary detection verified");

    // -------------------------------------------------------------
    // 3. File Limits & Chunk Bounding Tests
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing file limits, character caps, and chunk count limits...");

    // 3a. Oversized image (> 10MB)
    try {
      validateImageMetadata({
        originalName: "giant.png",
        mimeType: "image/png",
        size: MAX_ATTACHMENT_FILE_SIZE + 1,
      });
      assert.fail("Oversized image must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "FILE_TOO_LARGE");
    }

    // 3b. Oversized document (> 5MB)
    try {
      validateDocumentMetadata({
        originalName: "giant.pdf",
        mimeType: "application/pdf",
        size: MAX_DOCUMENT_FILE_SIZE + 1,
      });
      assert.fail("Oversized document must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "FILE_TOO_LARGE");
    }

    // 3c. Text document exceeding 100k extracted characters is strictly truncated
    const massiveText = "A".repeat(120_000);
    const extractedMassive = await extractDocumentText(massiveText, ".txt");
    assert.equal(
      extractedMassive.length,
      MAX_DOCUMENT_EXTRACTED_CHARS,
      "Extracted text must be capped strictly at MAX_DOCUMENT_EXTRACTED_CHARS (100,000)",
    );

    // 3d. Chunk count bounding: generating chunks from massive text produces at most MAX_DOCUMENT_CHUNKS (100)
    const chunks = chunkDocumentText("dummy-att-id", massiveText, {
      maxChunkSize: 500,
      chunkOverlap: 50,
    });
    assert.ok(
      chunks.length <= MAX_DOCUMENT_CHUNKS,
      `Chunk count (${chunks.length}) must be bounded by MAX_DOCUMENT_CHUNKS (${MAX_DOCUMENT_CHUNKS})`,
    );

    console.log("✓ File limits, 100k char extraction cap, and 100 chunk limit enforced");

    // -------------------------------------------------------------
    // 4. Failed Uploads & Input Validation Tests
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing failed uploads and input validation...");

    // 4a. Zero-byte image file
    try {
      validateImageMetadata({
        originalName: "empty.jpg",
        mimeType: "image/jpeg",
        size: 0,
      });
      assert.fail("0-byte image must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_FILE_SIZE");
    }

    // 4b. Zero-byte document file
    try {
      validateDocumentMetadata({
        originalName: "empty.txt",
        mimeType: "text/plain",
        size: 0,
      });
      assert.fail("0-byte document must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "EMPTY_FILE");
    }

    // 4c. Archived conversation rejection
    const archivedConv = await Conversation.create({
      userId: userA._id,
      title: `Archived Conv ${timestamp}`,
      status: CONVERSATION_STATUSES.ARCHIVED,
      messageCount: 0,
    });
    createdConversationIds.push(archivedConv._id.toString());

    try {
      await verifyAttachmentForMessage(
        attachmentA._id.toString(),
        userA._id.toString(),
        archivedConv._id.toString(),
      );
      assert.fail("Archived conversation must not accept attachments");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
    }

    console.log("✓ Failed upload scenarios and archived conversation rejection verified");

    // -------------------------------------------------------------
    // 5. Failed Extraction Safety Tests
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing failed extraction safety...");

    // 5a. Document text containing binary null bytes
    try {
      await extractDocumentText(Buffer.from("Hello\0World"), ".txt");
      assert.fail("Binary null byte must be rejected");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "TEXT_EXTRACTION_FAILED");
    }

    console.log("✓ Extraction failure safety verified");

    // -------------------------------------------------------------
    // 6. Failed Embeddings Resilience Tests
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing failed embeddings resilience and rollback...");

    // Create a new document to test embedding provider failure
    const docToFail = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "fail-test.txt",
      mimeType: "text/plain",
      size: 512,
      cloudinaryPublicId: `nexamind/fail_${timestamp}`,
      secureUrl: "https://res.cloudinary.com/nexamind/raw/upload/fail.txt",
      status: ATTACHMENT_STATUSES.READY,
      format: "txt",
      extractedText: "Some text to embed.",
      extractedTextLength: 19,
    });
    createdAttachmentIds.push(docToFail._id.toString());

    const failingProvider = new MockFailingEmbeddingProvider();
    try {
      await processDocumentEmbeddings(docToFail, { provider: failingProvider });
      assert.fail("Failing embedding provider must throw AppError 502");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 502);
      assert.equal(err.code, "AI_PROVIDER_ERROR");
    }

    // Verify attachment status was updated to FAILED and no orphan chunks exist
    const failedDocRecord = await Attachment.findById(docToFail._id);
    assert.equal(failedDocRecord?.status, ATTACHMENT_STATUSES.FAILED, "Attachment must be marked FAILED");

    const orphanChunksCount = await DocumentChunk.countDocuments({ attachmentId: docToFail._id });
    assert.equal(orphanChunksCount, 0, "No orphaned document chunks must exist after embedding failure");

    console.log("✓ Embedding failure handled gracefully: status marked FAILED and 0 orphan chunks");

    // -------------------------------------------------------------
    // 7. RAG Context Limits & Bounded Search Tests
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing RAG search bounds and threshold enforcement...");

    // 7a. Limit parameter cannot exceed MAX_RAG_TOP_K (10)
    const boundedSearchResult = await semanticDocumentSearch({
      userId: userA._id.toString(),
      conversationId: convA._id.toString(),
      query: "security hardening",
      limit: 100, // adversarial request requesting 100
      provider: testEmbeddingProvider,
    });
    assert.ok(
      boundedSearchResult.results.length <= MAX_RAG_TOP_K,
      `Search results must never exceed MAX_RAG_TOP_K (${MAX_RAG_TOP_K})`,
    );

    // 7b. Format RAG context respects character budget
    const formattedContext = formatRagDocumentContext(boundedSearchResult.results, 200);
    assert.ok(
      formattedContext.length <= 350, // includes truncation notice and footer
      "RAG context formatting must be strictly bounded",
    );
    assert.ok(
      formattedContext.includes("--- Relevant Document Context (RAG) ---"),
      "Must preserve RAG context delimiter",
    );

    console.log("✓ Bounded top-K and character budget limits strictly enforced");

    // -------------------------------------------------------------
    // 8. Storage Safety & Orphan Cleanup Tests
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing storage safety and orphan cleanup...");

    // Create an unreferenced attachment
    const orphanedAtt = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: ATTACHMENT_TYPES.IMAGE,
      originalName: "orphan.png",
      mimeType: "image/png",
      size: 1024,
      cloudinaryPublicId: `nexamind/orphan_${timestamp}`,
      secureUrl: "https://res.cloudinary.com/nexamind/image/upload/orphan.png",
      status: ATTACHMENT_STATUSES.READY,
    });

    const isCleaned = await cleanupAttachmentIfOrphaned(orphanedAtt._id.toString(), userA._id.toString());
    assert.equal(isCleaned, true, "Orphaned attachment should be deleted cleanly");

    const deletedCheck = await Attachment.findById(orphanedAtt._id);
    assert.equal(deletedCheck, null, "Orphaned attachment record must no longer exist in database");

    console.log("✓ Orphan cleanup safely removes unreferenced attachments");

    // -------------------------------------------------------------
    // 9. Normal Chat Unaffected Tests
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing normal chat continuity (no RAG/attachment)...");

    const normalChatResult = await orchestratorService.processChatRequest(
      userA._id.toString(),
      {
        conversationId: convA._id.toString(),
        content: "Hello! Tell me a joke without referencing documents.",
      },
      mockAiProvider,
    );

    assert.ok(normalChatResult.userMessage.id, "User message must be created");
    assert.ok(normalChatResult.assistantMessage.id, "Assistant message must be created");
    assert.equal(normalChatResult.sources, null, "Normal chat must have null sources (no phantom sources)");
    assert.equal(normalChatResult.assistantMessage.sources, null, "Assistant message sources must be null");

    const userABalance = await TokenBalance.findOne({ userId: userA._id });
    assert.equal(userABalance?.balance, 99, "Normal chat must deduct exactly 1 credit");

    console.log("✓ Normal chat is completely unaffected and operates seamlessly");

    console.log("\n=======================================================");
    console.log(" ALL 9 PRODUCTION HARDENING TESTS PASSED SUCCESSFULLY  ");
    console.log("=======================================================\n");
  } finally {
    setDefaultEmbeddingProvider(originalEmbeddingProvider);
    server.close();

    if (createdAttachmentIds.length > 0) {
      await DocumentChunk.deleteMany({ attachmentId: { $in: createdAttachmentIds } });
      await Attachment.deleteMany({ _id: { $in: createdAttachmentIds } });
    }
    if (createdConversationIds.length > 0) {
      await Conversation.deleteMany({ _id: { $in: createdConversationIds } });
    }
    if (createdUserIds.length > 0) {
      await TokenBalance.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Production hardening test failed:", err);
  process.exit(1);
});
