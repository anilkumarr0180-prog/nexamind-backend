import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { MAX_DOCUMENT_PROMPT_CHARS } from "../src/modules/ai/context-builder.service.js";
import type { AIProvider, AIMessage, AIResponse, AIStreamChunk } from "../src/modules/ai/providers/ai-provider.interface.js";

class MockDocumentAIProvider implements AIProvider {
  public readonly name = "mock-doc-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const last = messages[messages.length - 1];
    const content = last?.content ?? "";
    let reply = "Standard reply";
    if (content.includes("Attached Document:")) {
      reply = "Document analysis complete: " + content.slice(0, 100);
    }
    return {
      content: reply,
      provider: "mock-doc-provider",
      model: "test-model",
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    };
  }

  async *generateChatStream(messages: AIMessage[]): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streaming document answer: ", model: "test-model" };
    yield { content: "Complete.", model: "test-model", usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 }, done: true };
  }
}

const runTests = async () => {
  console.log("=== Starting Document Chat Context: Step 9 Automated Tests ===");

  await connectDatabase();

  const mockProvider = new MockDocumentAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = "http://127.0.0.1:" + port + "/api/v1";

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  try {
    const userA = await User.create({
      name: "Doc Chat User A",
      email: "doc_chat_a_" + timestamp + "@example.com",
      passwordHash: "secure_dummy_hash",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userA._id, balance: 50 });

    const userB = await User.create({
      name: "Doc Chat User B",
      email: "doc_chat_b_" + timestamp + "@example.com",
      passwordHash: "secure_dummy_hash",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userB._id, balance: 50 });

    const convA = await Conversation.create({
      userId: userA._id,
      title: "Doc Chat Conv A",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA._id.toString());

    const convA2 = await Conversation.create({
      userId: userA._id,
      title: "Doc Chat Conv A2",
      status: "ACTIVE",
    });
    createdConversationIds.push(convA2._id.toString());

    const convB = await Conversation.create({
      userId: userB._id,
      title: "Doc Chat Conv B",
      status: "ACTIVE",
    });
    createdConversationIds.push(convB._id.toString());

    // -------------------------------------------------------------
    // Test 1: Text-only chat unchanged
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing text-only chat unchanged...");
    mockProvider.calls = [];
    const res1 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Hello, this is a plain text chat without attachments.",
      }),
    });
    assert.equal(res1.status, 200, "Text-only chat should succeed with 200");
    const json1 = (await res1.json()) as any;
    assert.equal(json1.success, true);
    const chatCall1 = mockProvider.calls.find((c) => c.some((m) => m.content.includes("Hello, this is a plain text chat")));
    assert.ok(chatCall1, "Chat prompt call must be found");
    const sentPrompt1 = chatCall1[chatCall1.length - 1].content;
    assert.ok(!sentPrompt1.includes("--- Attached Document:"), "Text-only chat must not include document section");
    assert.ok(sentPrompt1.includes("Hello, this is a plain text chat without attachments."));
    console.log("✓ Text-only chat behavior verified unchanged");

    // -------------------------------------------------------------
    // Test 2: Valid document attachment included in context
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing valid document attachment included in AI context...");
    const docText = "NexaMind Engine Architecture:\n1. Core Agent Loop\n2. Tool Registry\n3. Context Builder";
    const docAttachment = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: "DOCUMENT",
      originalName: "architecture.txt",
      mimeType: "text/plain",
      size: docText.length,
      cloudinaryPublicId: "nexamind/docs/arch_123",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/arch.txt",
      status: "READY",
      format: "txt",
      extractedText: docText,
      extractedTextLength: docText.length,
    });
    createdAttachmentIds.push(docAttachment._id.toString());

    mockProvider.calls = [];
    const res2 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "What are the components mentioned in the file?",
        attachmentId: docAttachment._id.toString(),
      }),
    });
    assert.equal(res2.status, 200);
    const json2 = (await res2.json()) as any;
    assert.equal(json2.success, true);
    assert.equal(json2.data.userMessage.attachment.type, "DOCUMENT");
    assert.equal(json2.data.userMessage.attachment.originalName, "architecture.txt");
    assert.equal(json2.data.userMessage.attachment.extractedTextLength, docText.length);
    const chatCall2 = mockProvider.calls.find((c) => c.some((m) => m.content.includes("What are the components mentioned")));
    assert.ok(chatCall2, "Chat prompt call must be found");
    const sentPrompt2 = chatCall2[chatCall2.length - 1].content;
    assert.ok(sentPrompt2.includes("--- Attached Document: architecture.txt ---"), "Must include document header");
    assert.ok(sentPrompt2.includes(docText), "Must include extracted document text");
    assert.ok(sentPrompt2.includes("--- End of Attached Document ---"), "Must include document footer");
    assert.ok(sentPrompt2.includes("What are the components mentioned in the file?"), "Must include user query");
    console.log("✓ Document text accurately and clearly separated in AI context");

    // -------------------------------------------------------------
    // Test 3: Unauthorized attachment rejected
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing unauthorized attachment rejection...");
    const docB = await Attachment.create({
      userId: userB._id,
      conversationId: convB._id,
      type: "DOCUMENT",
      originalName: "userB_secret.txt",
      mimeType: "text/plain",
      size: 50,
      cloudinaryPublicId: "nexamind/docs/b_secret",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/b_secret.txt",
      status: "READY",
      format: "txt",
      extractedText: "Confidential User B document content",
      extractedTextLength: 36,
    });
    createdAttachmentIds.push(docB._id.toString());

    const balanceBeforeA = (await TokenBalance.findOne({ userId: userA._id }))?.balance ?? 0;
    const res3 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Analyze this unauthorized document",
        attachmentId: docB._id.toString(),
      }),
    });
    assert.equal(res3.status, 403, "Accessing another user document must return 403");
    const json3 = (await res3.json()) as any;
    assert.equal(json3.error.code, "FORBIDDEN");
    const balanceAfterA = (await TokenBalance.findOne({ userId: userA._id }))?.balance ?? 0;
    assert.equal(balanceAfterA, balanceBeforeA, "No credits deducted when attachment unauthorized");
    console.log("✓ Unauthorized attachment strictly rejected with 403 FORBIDDEN and 0 credits deducted");

    // -------------------------------------------------------------
    // Test 4: Cross-conversation attachment rejected
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-conversation attachment rejection...");
    const docConvA2 = await Attachment.create({
      userId: userA._id,
      conversationId: convA2._id,
      type: "DOCUMENT",
      originalName: "convA2_doc.txt",
      mimeType: "text/plain",
      size: 40,
      cloudinaryPublicId: "nexamind/docs/a2_doc",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/a2_doc.txt",
      status: "READY",
      format: "txt",
      extractedText: "Conversation A2 text",
      extractedTextLength: 19,
    });
    createdAttachmentIds.push(docConvA2._id.toString());

    const res4 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Cross conversation test",
        attachmentId: docConvA2._id.toString(),
      }),
    });
    assert.equal(res4.status, 400, "Attachment from another conversation must return 400");
    const json4 = (await res4.json()) as any;
    assert.equal(json4.error.code, "INVALID_ATTACHMENT_CONVERSATION");
    console.log("✓ Cross-conversation attachment rejected with 400 INVALID_ATTACHMENT_CONVERSATION");

    // -------------------------------------------------------------
    // Test 5: Oversized extracted text safely bounded
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing oversized extracted text safely bounded...");
    const oversizedChars = 30000;
    const hugeText = "ABCDEFGH ".repeat(oversizedChars / 9);
    const hugeDoc = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: "DOCUMENT",
      originalName: "huge_log.txt",
      mimeType: "text/plain",
      size: hugeText.length,
      cloudinaryPublicId: "nexamind/docs/huge_log",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/huge_log.txt",
      status: "READY",
      format: "txt",
      extractedText: hugeText,
      extractedTextLength: hugeText.length,
    });
    createdAttachmentIds.push(hugeDoc._id.toString());

    mockProvider.calls = [];
    const res5 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Summarize this huge file",
        attachmentId: hugeDoc._id.toString(),
      }),
    });
    assert.equal(res5.status, 200);
    const chatCall5 = mockProvider.calls.find((c) => c.some((m) => m.content.includes("Summarize this huge file")));
    assert.ok(chatCall5, "Chat prompt call must be found");
    const sentPrompt5 = chatCall5[chatCall5.length - 1].content;
    assert.ok(sentPrompt5.includes("[... Document truncated:"), "Prompt must contain truncation notice");
    assert.ok(sentPrompt5.length <= MAX_DOCUMENT_PROMPT_CHARS + 2000, "Prompt must not blow past max prompt chars");
    console.log("✓ Oversized extracted text safely bounded without consuming whole context window");

    // -------------------------------------------------------------
    // Test 6: READY/failed attachment behavior
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing non-READY/failed attachment rejection...");
    const failedDoc = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: "DOCUMENT",
      originalName: "failed.txt",
      mimeType: "text/plain",
      size: 100,
      cloudinaryPublicId: "nexamind/docs/failed",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/failed.txt",
      status: "FAILED",
      format: "txt",
    });
    createdAttachmentIds.push(failedDoc._id.toString());

    const res6 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Try failed attachment",
        attachmentId: failedDoc._id.toString(),
      }),
    });
    assert.equal(res6.status, 400);
    const json6 = (await res6.json()) as any;
    assert.equal(json6.error.code, "ATTACHMENT_NOT_READY");
    console.log("✓ Failed attachment safely rejected with 400 ATTACHMENT_NOT_READY");

    // -------------------------------------------------------------
    // Test 7: Summarization / Question Answering with MD content
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing document summarization and question answering...");
    const mdContent = "# Project Roadmap\n\n## Q1 Milestones\n- Deliver agent loop\n- Enable document upload\n\n## Q2 Milestones\n- Vector embeddings\n- Multimodal vision";
    const mdDoc = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: "DOCUMENT",
      originalName: "roadmap.md",
      mimeType: "text/markdown",
      size: mdContent.length,
      cloudinaryPublicId: "nexamind/docs/roadmap",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/roadmap.md",
      status: "READY",
      format: "md",
      extractedText: mdContent,
      extractedTextLength: mdContent.length,
    });
    createdAttachmentIds.push(mdDoc._id.toString());

    mockProvider.calls = [];
    const res7 = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Summarize this file and explain the main points",
        attachmentId: mdDoc._id.toString(),
      }),
    });
    assert.equal(res7.status, 200);
    const json7 = (await res7.json()) as any;
    assert.equal(json7.success, true);
    assert.ok(json7.data.assistantMessage.content.length > 0);
    const chatCall7 = mockProvider.calls.find((c) => c.some((m) => m.content.includes("Summarize this file and explain the main points")));
    assert.ok(chatCall7, "Chat prompt call must be found");
    const sentPrompt7 = chatCall7[chatCall7.length - 1].content;
    assert.ok(sentPrompt7.includes("--- Attached Document: roadmap.md ---"));
    assert.ok(sentPrompt7.includes("## Q1 Milestones"));
    assert.ok(sentPrompt7.includes("Summarize this file and explain the main points"));
    console.log("✓ Document summarization request verified in AI context pipeline");

    // -------------------------------------------------------------
    // Test 8: Streaming still works with document attachment
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing streaming chat with document attachment...");
    const csvContent = "user_id,action,timestamp\n101,login,2026-09-25T10:00:00Z\n102,upload,2026-09-25T10:05:00Z";
    const csvDoc = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      type: "DOCUMENT",
      originalName: "events.csv",
      mimeType: "text/csv",
      size: csvContent.length,
      cloudinaryPublicId: "nexamind/docs/events",
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/events.csv",
      status: "READY",
      format: "csv",
      extractedText: csvContent,
      extractedTextLength: csvContent.length,
    });
    createdAttachmentIds.push(csvDoc._id.toString());

    mockProvider.calls = [];
    const streamedChunks: string[] = [];
    const streamResult = await orchestratorService.processChatStream(
      userA._id.toString(),
      {
        conversationId: convA._id.toString(),
        content: "What events are recorded in this CSV?",
        attachmentId: csvDoc._id.toString(),
      },
      {
        onChunk: (chunk) => streamedChunks.push(chunk),
      },
      undefined,
      mockProvider,
    );
    assert.ok(streamResult);
    assert.ok(streamedChunks.length > 0, "Should have received stream chunks");
    const chatCall8 = mockProvider.calls.find((c) => c.some((m) => m.content.includes("What events are recorded in this CSV?")));
    assert.ok(chatCall8, "Stream prompt call must be found");
    const sentPrompt8 = chatCall8[chatCall8.length - 1].content;
    assert.ok(sentPrompt8.includes("--- Attached Document: events.csv ---"));
    assert.ok(sentPrompt8.includes("user_id,action,timestamp"));
    assert.ok(sentPrompt8.includes("What events are recorded in this CSV?"));
    console.log("✓ Streaming with document attachment verified successfully");

    console.log("\n=======================================================");
    console.log(" ALL 8 STEP 9 DOCUMENT CHAT CONTEXT TESTS PASSED ");
    console.log("=======================================================\n");
  } finally {
    server.close();
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
  console.error("Document chat context test failed:", err);
  process.exit(1);
});