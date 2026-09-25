import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as cloudinaryModule from "../src/config/cloudinary.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import {
  MAX_DOCUMENT_FILE_SIZE,
  MAX_PDF_PAGES,
} from "../src/modules/attachments/attachment.types.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockPdfAIProvider implements AIProvider {
  public readonly name = "mock-pdf-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const last = messages[messages.length - 1];
    const content = last?.content ?? "";
    let reply = "Standard reply";
    if (content.includes("Attached Document:")) {
      reply = "PDF analysis reply: Successfully read PDF document content.";
    }
    return {
      content: reply,
      provider: "mock-pdf-provider",
      model: "test-pdf-model",
      usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streaming PDF answer: ", model: "test-pdf-model" };
    yield {
      content: "Complete analysis of PDF.",
      model: "test-pdf-model",
      usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
      done: true,
    };
  }
}

// Helpers to create valid and edge-case PDF buffers
const createValidTextPdf = (text: string): Buffer => {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const streamContent = `BT /F1 12 Tf 72 712 Td (${escapedText}) Tj ET`;
  const streamLength = Buffer.byteLength(streamContent);
  const pdfString = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamLength} >> stream
${streamContent}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000236 00000 n 
0000000330 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref 407
%%EOF`;
  return Buffer.from(pdfString);
};

const createEmptyPagePdf = (): Buffer => {
  const pdfString = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
xref
0 4
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
trailer << /Size 4 /Root 1 0 R >>
startxref 200
%%EOF`;
  return Buffer.from(pdfString);
};

const createMultiPagePdf = (numPages: number): Buffer => {
  const objects: string[] = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj");
  const kids = Array.from({ length: numPages }, (_, i) => `${i + 3} 0 R`).join(" ");
  objects.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${numPages} >> endobj`);
  for (let i = 0; i < numPages; i++) {
    const pageId = i + 3;
    objects.push(`${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`);
  }
  const body = objects.join("\n");
  const pdfString = `%PDF-1.4\n${body}\nxref\n0 ${objects.length + 1}\n0000000000 65535 f \ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref 100\n%%EOF`;
  return Buffer.from(pdfString);
};

const runTests = async () => {
  console.log("=== Starting PDF Document Support: Step 11 Automated Tests ===");

  await connectDatabase();

  const mockProvider = new MockPdfAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = "http://127.0.0.1:" + port;

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const cloudinaryPublicIdsToClean: string[] = [];

  try {
    // Setup Test User A
    const userA = await User.create({
      name: "PDF Test User A",
      email: "pdf_user_a_" + timestamp + "@example.com",
      passwordHash: "secure_dummy_hash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    const tokenA = generateAccessToken({
      sub: userA._id.toString(),
      roles: ["USER"],
    });
    await TokenBalance.create({ userId: userA._id, balance: 100 });

    // Setup Test User B (for cross-user authorization tests)
    const userB = await User.create({
      name: "PDF Test User B",
      email: "pdf_user_b_" + timestamp + "@example.com",
      passwordHash: "secure_dummy_hash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    const tokenB = generateAccessToken({
      sub: userB._id.toString(),
      roles: ["USER"],
    });
    await TokenBalance.create({ userId: userB._id, balance: 100 });

    // Conversation A
    const conversationA = await Conversation.create({
      userId: userA._id,
      title: "PDF Conversation A " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationA._id.toString());

    // Conversation B
    const conversationB = await Conversation.create({
      userId: userB._id,
      title: "PDF Conversation B " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationB._id.toString());

    // -------------------------------------------------------------
    // Test 1: Valid text PDF upload & extraction
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing valid text PDF upload and extraction...");
    const sampleText = "NexaMind Quarterly Executive Report: All AI capabilities operational.";
    const validPdfBuffer = createValidTextPdf(sampleText);

    const form1 = new FormData();
    form1.append(
      "file",
      new Blob([validPdfBuffer], { type: "application/pdf" }),
      "executive_report.pdf",
    );
    form1.append("conversationId", conversationA._id.toString());

    const res1 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form1,
    });
    assert.equal(res1.status, 201, "Valid PDF upload must return 201 Created");
    const json1 = (await res1.json()) as any;
    assert.equal(json1.success, true);
    assert.equal(json1.data.type, "DOCUMENT");
    assert.equal(json1.data.originalName, "executive_report.pdf");
    assert.equal(json1.data.mimeType, "application/pdf");
    assert.equal(json1.data.size, validPdfBuffer.length);
    assert.equal(json1.data.status, "READY");
    assert.ok(json1.data.extractedTextLength > 0, "extractedTextLength must be > 0");
    assert.ok(json1.data.secureUrl.startsWith("https://res.cloudinary.com/"));
    createdAttachmentIds.push(json1.data.attachmentId);

    const dbDoc1 = await Attachment.findById(json1.data.attachmentId);
    assert.ok(dbDoc1, "Document record must exist in DB");
    assert.equal(dbDoc1.type, "DOCUMENT");
    assert.equal(dbDoc1.format, "pdf");
    assert.ok(dbDoc1.extractedText?.includes("NexaMind Quarterly Executive Report"));
    assert.equal(dbDoc1.extractedTextLength, dbDoc1.extractedText?.length);
    cloudinaryPublicIdsToClean.push(dbDoc1.cloudinaryPublicId);
    console.log("✓ Valid text PDF upload, Cloudinary storage, and text extraction verified");

    // -------------------------------------------------------------
    // Test 2: Empty/scanned PDF (no text extractable)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing empty/scanned PDF rejection...");
    const emptyPdfBuffer = createEmptyPagePdf();
    const form2 = new FormData();
    form2.append(
      "file",
      new Blob([emptyPdfBuffer], { type: "application/pdf" }),
      "scanned_receipt.pdf",
    );
    form2.append("conversationId", conversationA._id.toString());

    const res2 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form2,
    });
    assert.equal(res2.status, 400, "Empty/scanned PDF must be rejected with 400");
    const json2 = (await res2.json()) as any;
    assert.equal(json2.success, false);
    assert.equal(json2.error.code, "UNPROCESSABLE_PDF");
    assert.ok(
      json2.error.message.includes("Scanned or image-only PDFs are not currently supported"),
      "Error message must clearly explain scanned/image-only PDFs are unprocessable",
    );
    console.log("✓ Empty/scanned PDF safely rejected with 400 UNPROCESSABLE_PDF");

    // -------------------------------------------------------------
    // Test 3: Invalid / corrupted PDF file
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing invalid/corrupted PDF rejection...");
    const corruptBuffer = Buffer.from("THIS_IS_DEFINITELY_NOT_A_VALID_PDF_STRUCTURE");
    const form3 = new FormData();
    form3.append(
      "file",
      new Blob([corruptBuffer], { type: "application/pdf" }),
      "corrupted.pdf",
    );
    form3.append("conversationId", conversationA._id.toString());

    const res3 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form3,
    });
    assert.equal(res3.status, 400, "Corrupt PDF must be rejected with 400");
    const json3 = (await res3.json()) as any;
    assert.equal(json3.success, false);
    assert.equal(json3.error.code, "INVALID_PDF");
    console.log("✓ Invalid/corrupted PDF safely rejected with 400 INVALID_PDF");

    // -------------------------------------------------------------
    // Test 4: Oversized PDF rejection (>5MB)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing oversized PDF rejection...");
    const oversizedBytes = MAX_DOCUMENT_FILE_SIZE + 2048;
    const oversizedBuffer = Buffer.alloc(oversizedBytes, "A");
    const form4 = new FormData();
    form4.append(
      "file",
      new Blob([oversizedBuffer], { type: "application/pdf" }),
      "huge.pdf",
    );
    form4.append("conversationId", conversationA._id.toString());

    const res4 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form4,
    });
    assert.equal(res4.status, 400, "Oversized PDF must be rejected with 400");
    const json4 = (await res4.json()) as any;
    assert.equal(json4.success, false);
    assert.equal(json4.error.code, "FILE_TOO_LARGE");
    console.log("✓ Oversized PDF safely rejected with 400 FILE_TOO_LARGE");

    // -------------------------------------------------------------
    // Test 5: Unauthorized conversation ownership rejection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing unauthorized conversation ownership...");
    const form5 = new FormData();
    form5.append(
      "file",
      new Blob([validPdfBuffer], { type: "application/pdf" }),
      "hacked.pdf",
    );
    form5.append("conversationId", conversationA._id.toString());

    const res5 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenB },
      body: form5,
    });
    assert.equal(res5.status, 403, "Uploading to another user conversation must return 403");
    const json5 = (await res5.json()) as any;
    assert.equal(json5.success, false);
    assert.equal(json5.error.code, "FORBIDDEN");
    console.log("✓ Cross-user conversation upload rejected with 403 FORBIDDEN");

    // -------------------------------------------------------------
    // Test 6: PDF with excessive page count (>MAX_PDF_PAGES)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing excessive page count limit rejection...");
    const excessivePdfBuffer = createMultiPagePdf(MAX_PDF_PAGES + 5);
    const form6 = new FormData();
    form6.append(
      "file",
      new Blob([excessivePdfBuffer], { type: "application/pdf" }),
      "too_many_pages.pdf",
    );
    form6.append("conversationId", conversationA._id.toString());

    const res6 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form6,
    });
    assert.equal(res6.status, 400, "Excessive page count must return 400");
    const json6 = (await res6.json()) as any;
    assert.equal(json6.success, false);
    assert.equal(json6.error.code, "PDF_TOO_MANY_PAGES");
    console.log("✓ PDF exceeding page limit rejected with 400 PDF_TOO_MANY_PAGES");

    // -------------------------------------------------------------
    // Test 7: Existing TXT, MD, JSON, and CSV documents still work
    // -------------------------------------------------------------
    console.log("\n[Test 7] Verifying existing TXT, MD, JSON, CSV document upload...");
    // TXT
    const txtContent = "Regression check: TXT documents still function.";
    const txtForm = new FormData();
    txtForm.append("file", new Blob([Buffer.from(txtContent)], { type: "text/plain" }), "reg.txt");
    txtForm.append("conversationId", conversationA._id.toString());
    const txtRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: txtForm,
    });
    assert.equal(txtRes.status, 201);
    const txtJson = (await txtRes.json()) as any;
    createdAttachmentIds.push(txtJson.data.attachmentId);

    // MD
    const mdContent = "# Markdown Check\n- item 1\n- item 2";
    const mdForm = new FormData();
    mdForm.append("file", new Blob([Buffer.from(mdContent)], { type: "text/markdown" }), "reg.md");
    mdForm.append("conversationId", conversationA._id.toString());
    const mdRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: mdForm,
    });
    assert.equal(mdRes.status, 201);
    const mdJson = (await mdRes.json()) as any;
    createdAttachmentIds.push(mdJson.data.attachmentId);

    // JSON
    const jsonContent = JSON.stringify({ status: "ok", version: 11 });
    const jsonForm = new FormData();
    jsonForm.append("file", new Blob([Buffer.from(jsonContent)], { type: "application/json" }), "reg.json");
    jsonForm.append("conversationId", conversationA._id.toString());
    const jsonRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: jsonForm,
    });
    assert.equal(jsonRes.status, 201);
    const jsonParsed = (await jsonRes.json()) as any;
    createdAttachmentIds.push(jsonParsed.data.attachmentId);

    // CSV
    const csvContent = "key,value\nname,NexaMind";
    const csvForm = new FormData();
    csvForm.append("file", new Blob([Buffer.from(csvContent)], { type: "text/csv" }), "reg.csv");
    csvForm.append("conversationId", conversationA._id.toString());
    const csvRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: csvForm,
    });
    assert.equal(csvRes.status, 201);
    const csvJson = (await csvRes.json()) as any;
    createdAttachmentIds.push(csvJson.data.attachmentId);

    console.log("✓ Existing TXT, MD, JSON, and CSV uploads verified unchanged and operational");

    // -------------------------------------------------------------
    // Test 8: AI Document-question flow with attached PDF
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing AI document-question flow with attached PDF...");
    mockProvider.calls = [];
    const chatRes = await fetch(baseUrl + "/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: conversationA._id.toString(),
        content: "What are the quarterly highlights mentioned in the attached PDF?",
        attachmentId: json1.data.attachmentId,
      }),
    });
    assert.equal(chatRes.status, 200, "AI chat with PDF attachment must return 200");
    const chatJson = (await chatRes.json()) as any;
    assert.equal(chatJson.success, true);
    assert.ok(chatJson.data.assistantMessage.content.length > 0);

    // Verify mock provider call received the document section
    assert.ok(mockProvider.calls.length > 0, "AI provider must have been invoked");
    const chatCall = mockProvider.calls.find((c) =>
      c.some((m) => m.content.includes("What are the quarterly highlights")),
    );
    assert.ok(chatCall, "Chat prompt call must be found in provider calls");
    const latestUserMsg = chatCall[chatCall.length - 1]!;
    assert.ok(
      latestUserMsg.content.includes("--- Attached Document: executive_report.pdf ---"),
      "Prompt must include attached document header",
    );
    assert.ok(
      latestUserMsg.content.includes("NexaMind Quarterly Executive Report"),
      "Prompt must include extracted PDF text",
    );
    assert.ok(
      latestUserMsg.content.includes("What are the quarterly highlights mentioned in the attached PDF?"),
      "Prompt must include user question",
    );
    console.log("✓ AI document-question flow successfully integrated and verified with PDF attachment");

    // -------------------------------------------------------------
    // Test 9: Streaming chat with attached PDF
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing streaming chat with attached PDF...");
    mockProvider.calls = [];
    const streamedChunks: string[] = [];
    const streamResult = await orchestratorService.processChatStream(
      userA._id.toString(),
      {
        conversationId: conversationA._id.toString(),
        content: "Summarize this PDF in stream mode",
        attachmentId: json1.data.attachmentId,
      },
      {
        onChunk: (chunk) => streamedChunks.push(chunk),
      },
      undefined,
      mockProvider,
    );
    assert.ok(streamResult);
    assert.ok(streamedChunks.length > 0, "Should have received stream chunks");
    const streamCall = mockProvider.calls.find((c) =>
      c.some((m) => m.content.includes("Summarize this PDF in stream mode")),
    );
    assert.ok(streamCall, "Stream call must be found in provider calls");
    const streamUserMsg = streamCall[streamCall.length - 1]!;
    assert.ok(streamUserMsg.content.includes("--- Attached Document: executive_report.pdf ---"));
    assert.ok(streamUserMsg.content.includes("NexaMind Quarterly Executive Report"));
    console.log("✓ Streaming chat with PDF attachment verified successfully");

    console.log("\n=======================================================");
    console.log(" ALL 9 STEP 11 PDF DOCUMENT TESTS PASSED SUCCESSFULLY ");
    console.log("=======================================================\n");
  } finally {
    server.close();
    for (const publicId of cloudinaryPublicIdsToClean) {
      try {
        await cloudinaryModule.deleteFileFromCloudinary(publicId, "raw");
      } catch (err) {}
    }
    if (createdAttachmentIds.length > 0) {
      await Attachment.deleteMany({ _id: { $in: createdAttachmentIds } });
    }
    if (createdConversationIds.length > 0) {
      await Conversation.deleteMany({ _id: { $in: createdConversationIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("PDF document test failed:", err);
  process.exit(1);
});
