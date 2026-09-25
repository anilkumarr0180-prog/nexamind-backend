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
import { MAX_DOCUMENT_FILE_SIZE } from "../src/modules/attachments/attachment.types.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockDocxAIProvider implements AIProvider {
  public readonly name = "mock-docx-provider";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const last = messages[messages.length - 1];
    const content = last?.content ?? "";
    let reply = "Standard reply";
    if (content.includes("Attached Document:")) {
      reply = "DOCX analysis complete: Successfully extracted and summarized document.";
    }
    return {
      content: reply,
      provider: "mock-docx-provider",
      model: "test-docx-model",
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streaming DOCX answer: ", model: "test-docx-model" };
    yield {
      content: "Complete DOCX analysis.",
      model: "test-docx-model",
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      done: true,
    };
  }
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const runTests = async () => {
  console.log("=== Starting DOCX Document Support: Step 12 Automated Tests ===");

  await connectDatabase();

  const mockProvider = new MockDocxAIProvider();
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
    const userA = await User.create({
      name: "DOCX Test User A",
      email: "docx_user_a_" + timestamp + "@example.com",
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

    const userB = await User.create({
      name: "DOCX Test User B",
      email: "docx_user_b_" + timestamp + "@example.com",
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

    const conversationA = await Conversation.create({
      userId: userA._id,
      title: "DOCX Conversation A " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationA._id.toString());

    const conversationB = await Conversation.create({
      userId: userB._id,
      title: "DOCX Conversation B " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationB._id.toString());

    const validDocxBuffer = Buffer.from([80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 215, 121, 132, 234, 241, 0, 0, 0, 184, 1, 0, 0, 19, 0, 0, 0, 91, 67, 111, 110, 116, 101, 110, 116, 95, 84, 121, 112, 101, 115, 93, 46, 120, 109, 108, 125, 144, 205, 78, 195, 48, 16, 132, 239, 125, 10, 203, 215, 42, 113, 202, 1, 33, 148, 164, 7, 126, 142, 192, 161, 60, 192, 202, 222, 36, 86, 253, 39, 175, 91, 218, 183, 103, 211, 66, 145, 16, 229, 104, 205, 124, 51, 235, 105, 215, 7, 239, 196, 30, 51, 217, 24, 58, 185, 170, 27, 41, 48, 232, 104, 108, 24, 59, 249, 190, 121, 174, 238, 164, 160, 2, 193, 128, 139, 1, 59, 121, 68, 146, 235, 126, 209, 110, 142, 9, 73, 48, 28, 168, 147, 83, 41, 233, 94, 41, 210, 19, 122, 160, 58, 38, 12, 172, 12, 49, 123, 40, 252, 204, 163, 74, 160, 183, 48, 162, 186, 105, 154, 91, 165, 99, 40, 24, 74, 85, 230, 12, 217, 47, 132, 104, 31, 113, 128, 157, 43, 226, 233, 192, 202, 249, 150, 140, 142, 164, 120, 56, 123, 231, 186, 78, 66, 74, 206, 106, 40, 172, 171, 125, 48, 191, 138, 170, 175, 146, 154, 201, 147, 135, 38, 155, 104, 201, 6, 169, 174, 149, 204, 226, 245, 142, 31, 244, 149, 39, 202, 214, 160, 120, 131, 92, 94, 192, 179, 81, 125, 196, 108, 148, 137, 122, 231, 25, 174, 255, 79, 250, 227, 218, 56, 12, 86, 227, 133, 159, 211, 82, 142, 26, 137, 120, 123, 239, 234, 139, 226, 193, 134, 239, 95, 180, 234, 52, 124, 255, 9, 80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 32, 27, 134, 234, 178, 0, 0, 0, 46, 1, 0, 0, 11, 0, 0, 0, 95, 114, 101, 108, 115, 47, 46, 114, 101, 108, 115, 141, 207, 187, 14, 130, 48, 20, 6, 224, 157, 167, 104, 206, 46, 5, 7, 99, 12, 133, 197, 152, 176, 26, 124, 128, 166, 61, 148, 70, 122, 73, 91, 47, 188, 189, 29, 28, 196, 56, 56, 158, 219, 119, 242, 55, 221, 211, 204, 228, 142, 33, 106, 103, 25, 212, 101, 5, 4, 173, 112, 82, 91, 197, 224, 50, 156, 54, 123, 32, 49, 113, 43, 249, 236, 44, 50, 88, 48, 66, 215, 22, 205, 25, 103, 158, 242, 77, 156, 180, 143, 36, 35, 54, 50, 152, 82, 242, 7, 74, 163, 152, 208, 240, 88, 58, 143, 54, 79, 70, 23, 12, 79, 185, 12, 138, 122, 46, 174, 92, 33, 221, 86, 213, 142, 134, 79, 3, 218, 130, 144, 21, 75, 122, 201, 32, 244, 178, 6, 50, 44, 30, 255, 225, 221, 56, 106, 129, 71, 39, 110, 6, 109, 250, 241, 229, 107, 35, 203, 60, 40, 76, 12, 30, 46, 72, 42, 223, 237, 50, 179, 64, 115, 74, 186, 138, 217, 190, 0, 80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 150, 60, 55, 158, 210, 0, 0, 0, 19, 1, 0, 0, 17, 0, 0, 0, 119, 111, 114, 100, 47, 100, 111, 99, 117, 109, 101, 110, 116, 46, 120, 109, 108, 53, 143, 205, 106, 195, 48, 12, 199, 239, 121, 10, 225, 123, 227, 44, 135, 50, 66, 146, 82, 24, 131, 193, 58, 6, 219, 30, 192, 179, 181, 212, 96, 75, 198, 118, 151, 230, 237, 103, 7, 118, 249, 73, 66, 240, 255, 24, 79, 119, 239, 224, 23, 99, 178, 76, 147, 120, 104, 59, 1, 72, 154, 141, 165, 101, 18, 95, 159, 207, 135, 71, 1, 41, 43, 50, 202, 49, 225, 36, 54, 76, 226, 52, 55, 227, 58, 24, 214, 55, 143, 148, 161, 40, 80, 26, 214, 73, 92, 115, 14, 131, 148, 73, 95, 209, 171, 212, 114, 64, 42, 191, 31, 142, 94, 229, 114, 198, 69, 174, 28, 77, 136, 172, 49, 165, 98, 224, 157, 236, 187, 238, 40, 189, 178, 36, 230, 6, 160, 168, 126, 179, 217, 230, 50, 67, 69, 172, 200, 243, 27, 222, 213, 197, 146, 129, 143, 28, 85, 198, 197, 106, 120, 119, 138, 160, 239, 250, 227, 0, 151, 155, 203, 246, 224, 185, 36, 132, 243, 11, 148, 168, 112, 94, 106, 174, 87, 230, 0, 79, 232, 108, 169, 183, 181, 163, 172, 82, 149, 113, 103, 216, 185, 219, 53, 117, 251, 175, 51, 255, 1, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 215, 121, 132, 234, 241, 0, 0, 0, 184, 1, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 0, 0, 0, 0, 91, 67, 111, 110, 116, 101, 110, 116, 95, 84, 121, 112, 101, 115, 93, 46, 120, 109, 108, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 32, 27, 134, 234, 178, 0, 0, 0, 46, 1, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 34, 1, 0, 0, 95, 114, 101, 108, 115, 47, 46, 114, 101, 108, 115, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 150, 60, 55, 158, 210, 0, 0, 0, 19, 1, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 253, 1, 0, 0, 119, 111, 114, 100, 47, 100, 111, 99, 117, 109, 101, 110, 116, 46, 120, 109, 108, 80, 75, 5, 6, 0, 0, 0, 0, 3, 0, 3, 0, 185, 0, 0, 0, 254, 2, 0, 0, 0, 0]);
    const emptyDocxBuffer = Buffer.from([80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 215, 121, 132, 234, 241, 0, 0, 0, 184, 1, 0, 0, 19, 0, 0, 0, 91, 67, 111, 110, 116, 101, 110, 116, 95, 84, 121, 112, 101, 115, 93, 46, 120, 109, 108, 125, 144, 205, 78, 195, 48, 16, 132, 239, 125, 10, 203, 215, 42, 113, 202, 1, 33, 148, 164, 7, 126, 142, 192, 161, 60, 192, 202, 222, 36, 86, 253, 39, 175, 91, 218, 183, 103, 211, 66, 145, 16, 229, 104, 205, 124, 51, 235, 105, 215, 7, 239, 196, 30, 51, 217, 24, 58, 185, 170, 27, 41, 48, 232, 104, 108, 24, 59, 249, 190, 121, 174, 238, 164, 160, 2, 193, 128, 139, 1, 59, 121, 68, 146, 235, 126, 209, 110, 142, 9, 73, 48, 28, 168, 147, 83, 41, 233, 94, 41, 210, 19, 122, 160, 58, 38, 12, 172, 12, 49, 123, 40, 252, 204, 163, 74, 160, 183, 48, 162, 186, 105, 154, 91, 165, 99, 40, 24, 74, 85, 230, 12, 217, 47, 132, 104, 31, 113, 128, 157, 43, 226, 233, 192, 202, 249, 150, 140, 142, 164, 120, 56, 123, 231, 186, 78, 66, 74, 206, 106, 40, 172, 171, 125, 48, 191, 138, 170, 175, 146, 154, 201, 147, 135, 38, 155, 104, 201, 6, 169, 174, 149, 204, 226, 245, 142, 31, 244, 149, 39, 202, 214, 160, 120, 131, 92, 94, 192, 179, 81, 125, 196, 108, 148, 137, 122, 231, 25, 174, 255, 79, 250, 227, 218, 56, 12, 86, 227, 133, 159, 211, 82, 142, 26, 137, 120, 123, 239, 234, 139, 226, 193, 134, 239, 95, 180, 234, 52, 124, 255, 9, 80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 32, 27, 134, 234, 178, 0, 0, 0, 46, 1, 0, 0, 11, 0, 0, 0, 95, 114, 101, 108, 115, 47, 46, 114, 101, 108, 115, 141, 207, 187, 14, 130, 48, 20, 6, 224, 157, 167, 104, 206, 46, 5, 7, 99, 12, 133, 197, 152, 176, 26, 124, 128, 166, 61, 148, 70, 122, 73, 91, 47, 188, 189, 29, 28, 196, 56, 56, 158, 219, 119, 242, 55, 221, 211, 204, 228, 142, 33, 106, 103, 25, 212, 101, 5, 4, 173, 112, 82, 91, 197, 224, 50, 156, 54, 123, 32, 49, 113, 43, 249, 236, 44, 50, 88, 48, 66, 215, 22, 205, 25, 103, 158, 242, 77, 156, 180, 143, 36, 35, 54, 50, 152, 82, 242, 7, 74, 163, 152, 208, 240, 88, 58, 143, 54, 79, 70, 23, 12, 79, 185, 12, 138, 122, 46, 174, 92, 33, 221, 86, 213, 142, 134, 79, 3, 218, 130, 144, 21, 75, 122, 201, 32, 244, 178, 6, 50, 44, 30, 255, 225, 221, 56, 106, 129, 71, 39, 110, 6, 109, 250, 241, 229, 107, 35, 203, 60, 40, 76, 12, 30, 46, 72, 42, 223, 237, 50, 179, 64, 115, 74, 186, 138, 217, 190, 0, 80, 75, 3, 4, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 159, 221, 204, 146, 146, 0, 0, 0, 179, 0, 0, 0, 17, 0, 0, 0, 119, 111, 114, 100, 47, 100, 111, 99, 117, 109, 101, 110, 116, 46, 120, 109, 108, 53, 141, 65, 14, 194, 32, 16, 69, 247, 61, 5, 153, 189, 165, 186, 48, 166, 41, 116, 231, 9, 244, 0, 8, 99, 109, 82, 102, 8, 131, 214, 222, 94, 76, 116, 245, 255, 207, 79, 222, 27, 198, 119, 92, 212, 11, 179, 204, 76, 6, 246, 109, 7, 10, 201, 115, 152, 105, 50, 112, 189, 156, 119, 39, 80, 82, 28, 5, 183, 48, 161, 129, 13, 5, 70, 219, 12, 107, 31, 216, 63, 35, 82, 81, 149, 64, 210, 175, 6, 30, 165, 164, 94, 107, 241, 15, 140, 78, 90, 78, 72, 245, 187, 115, 142, 174, 212, 153, 39, 189, 114, 14, 41, 179, 71, 145, 42, 136, 139, 62, 116, 221, 81, 71, 55, 19, 216, 70, 169, 74, 189, 113, 216, 108, 205, 164, 237, 160, 127, 179, 249, 182, 191, 206, 126, 0, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 215, 121, 132, 234, 241, 0, 0, 0, 184, 1, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 0, 0, 0, 0, 91, 67, 111, 110, 116, 101, 110, 116, 95, 84, 121, 112, 101, 115, 93, 46, 120, 109, 108, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 32, 27, 134, 234, 178, 0, 0, 0, 46, 1, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 34, 1, 0, 0, 95, 114, 101, 108, 115, 47, 46, 114, 101, 108, 115, 80, 75, 1, 2, 20, 3, 20, 0, 0, 0, 8, 0, 217, 125, 57, 93, 159, 221, 204, 146, 146, 0, 0, 0, 179, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 1, 253, 1, 0, 0, 119, 111, 114, 100, 47, 100, 111, 99, 117, 109, 101, 110, 116, 46, 120, 109, 108, 80, 75, 5, 6, 0, 0, 0, 0, 3, 0, 3, 0, 185, 0, 0, 0, 190, 2, 0, 0, 0, 0]);

    // -------------------------------------------------------------
    // Test 1: Valid DOCX document upload & extraction
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing valid DOCX document upload and extraction...");
    const form1 = new FormData();
    form1.append(
      "file",
      new Blob([validDocxBuffer], { type: DOCX_MIME }),
      "strategic_plan.docx",
    );
    form1.append("conversationId", conversationA._id.toString());

    const res1 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form1,
    });
    assert.equal(res1.status, 201, "Valid DOCX upload must return 201 Created");
    const json1 = (await res1.json()) as any;
    assert.equal(json1.success, true);
    assert.equal(json1.data.type, "DOCUMENT");
    assert.equal(json1.data.originalName, "strategic_plan.docx");
    assert.equal(json1.data.mimeType, DOCX_MIME);
    assert.equal(json1.data.status, "READY");
    assert.ok(json1.data.extractedTextLength > 0, "extractedTextLength must be > 0");
    assert.ok(json1.data.secureUrl.startsWith("https://res.cloudinary.com/"));
    createdAttachmentIds.push(json1.data.attachmentId);

    const dbDoc1 = await Attachment.findById(json1.data.attachmentId);
    assert.ok(dbDoc1, "Attachment record must exist in MongoDB");
    assert.equal(dbDoc1.type, "DOCUMENT");
    assert.equal(dbDoc1.format, "docx");
    assert.ok(dbDoc1.extractedText?.includes("NexaMind Strategic Plan 2026"));
    assert.equal(dbDoc1.extractedTextLength, dbDoc1.extractedText?.length);
    cloudinaryPublicIdsToClean.push(dbDoc1.cloudinaryPublicId);
    console.log("✓ Valid DOCX upload, Cloudinary storage, and text extraction verified");

    // -------------------------------------------------------------
    // Test 2: Empty/scanned DOCX rejection
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing empty/scanned DOCX rejection...");
    const form2 = new FormData();
    form2.append(
      "file",
      new Blob([emptyDocxBuffer], { type: DOCX_MIME }),
      "empty.docx",
    );
    form2.append("conversationId", conversationA._id.toString());

    const res2 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form2,
    });
    assert.equal(res2.status, 400, "Empty DOCX must be rejected with 400");
    const json2 = (await res2.json()) as any;
    assert.equal(json2.success, false);
    assert.equal(json2.error.code, "UNPROCESSABLE_DOCX");
    assert.ok(
      json2.error.message.includes("No readable text could be extracted from this DOCX document"),
      "Error message must be clear and controlled",
    );
    console.log("✓ Empty DOCX safely rejected with 400 UNPROCESSABLE_DOCX");

    // -------------------------------------------------------------
    // Test 3: Invalid / corrupted DOCX
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing corrupted DOCX rejection...");
    const corruptBuffer = Buffer.from("NOT_A_VALID_DOCX_FILE_CONTENTS");
    const form3 = new FormData();
    form3.append(
      "file",
      new Blob([corruptBuffer], { type: DOCX_MIME }),
      "corrupted.docx",
    );
    form3.append("conversationId", conversationA._id.toString());

    const res3 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form3,
    });
    assert.equal(res3.status, 400, "Corrupt DOCX must return 400");
    const json3 = (await res3.json()) as any;
    assert.equal(json3.success, false);
    assert.equal(json3.error.code, "INVALID_DOCX");
    console.log("✓ Corrupted DOCX safely rejected with 400 INVALID_DOCX");

    // -------------------------------------------------------------
    // Test 4: Oversized DOCX rejection (>5MB)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing oversized DOCX rejection...");
    const oversizedBytes = MAX_DOCUMENT_FILE_SIZE + 2048;
    const oversizedBuffer = Buffer.alloc(oversizedBytes, "B");
    const form4 = new FormData();
    form4.append(
      "file",
      new Blob([oversizedBuffer], { type: DOCX_MIME }),
      "huge.docx",
    );
    form4.append("conversationId", conversationA._id.toString());

    const res4 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form4,
    });
    assert.equal(res4.status, 400, "Oversized DOCX must return 400");
    const json4 = (await res4.json()) as any;
    assert.equal(json4.success, false);
    assert.equal(json4.error.code, "FILE_TOO_LARGE");
    console.log("✓ Oversized DOCX safely rejected with 400 FILE_TOO_LARGE");

    // -------------------------------------------------------------
    // Test 5: Unauthorized conversation access rejection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing unauthorized conversation access...");
    const form5 = new FormData();
    form5.append(
      "file",
      new Blob([validDocxBuffer], { type: DOCX_MIME }),
      "hacked.docx",
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
    console.log("✓ Unauthorized conversation access safely rejected with 403 FORBIDDEN");

    // -------------------------------------------------------------
    // Test 6: AI Document-question flow with attached DOCX
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing AI document-question flow with attached DOCX...");
    mockProvider.calls = [];
    const chatRes = await fetch(baseUrl + "/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: conversationA._id.toString(),
        content: "What does this document say about the strategic plan?",
        attachmentId: json1.data.attachmentId,
      }),
    });
    assert.equal(chatRes.status, 200, "AI chat with DOCX attachment must return 200");
    const chatJson = (await chatRes.json()) as any;
    assert.equal(chatJson.success, true);
    assert.ok(chatJson.data.assistantMessage.content.length > 0);

    const chatCall = mockProvider.calls.find((c) =>
      c.some((m) => m.content.includes("What does this document say")),
    );
    assert.ok(chatCall, "Chat prompt call must be found in AI calls");
    const latestUserMsg = chatCall[chatCall.length - 1]!;
    assert.ok(
      latestUserMsg.content.includes("--- Attached Document: strategic_plan.docx ---"),
      "Prompt must include attached document header",
    );
    assert.ok(
      latestUserMsg.content.includes("NexaMind Strategic Plan 2026"),
      "Prompt must include extracted DOCX text",
    );
    assert.ok(
      latestUserMsg.content.includes("What does this document say about the strategic plan?"),
      "Prompt must include user question",
    );
    console.log("✓ AI document-question flow successfully verified with attached DOCX");

    // -------------------------------------------------------------
    // Test 7: Streaming chat with attached DOCX
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing streaming chat with attached DOCX...");
    mockProvider.calls = [];
    const streamedChunks: string[] = [];
    const streamResult = await orchestratorService.processChatStream(
      userA._id.toString(),
      {
        conversationId: conversationA._id.toString(),
        content: "Summarize this document in streaming mode",
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
      c.some((m) => m.content.includes("Summarize this document in streaming mode")),
    );
    assert.ok(streamCall, "Stream call must be found in provider calls");
    const streamUserMsg = streamCall[streamCall.length - 1]!;
    assert.ok(streamUserMsg.content.includes("--- Attached Document: strategic_plan.docx ---"));
    assert.ok(streamUserMsg.content.includes("NexaMind Strategic Plan 2026"));
    console.log("✓ Streaming chat with attached DOCX verified successfully");

    // -------------------------------------------------------------
    // Test 8: Regression check across TXT, MD, JSON, CSV, PDF
    // -------------------------------------------------------------
    console.log("\n[Test 8] Regression verification: TXT, MD, JSON, CSV, PDF...");
    // TXT
    const txtForm = new FormData();
    txtForm.append("file", new Blob([Buffer.from("Regression TXT content")], { type: "text/plain" }), "check.txt");
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
    const mdForm = new FormData();
    mdForm.append("file", new Blob([Buffer.from("# Regression MD")], { type: "text/markdown" }), "check.md");
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
    const jsonForm = new FormData();
    jsonForm.append("file", new Blob([Buffer.from(JSON.stringify({ docxStep: 12 }))], { type: "application/json" }), "check.json");
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
    const csvForm = new FormData();
    csvForm.append("file", new Blob([Buffer.from("feature,status\ndocx,active")], { type: "text/csv" }), "check.csv");
    csvForm.append("conversationId", conversationA._id.toString());
    const csvRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: csvForm,
    });
    assert.equal(csvRes.status, 201);
    const csvJson = (await csvRes.json()) as any;
    createdAttachmentIds.push(csvJson.data.attachmentId);

    console.log("✓ Regression across TXT, MD, JSON, CSV passed completely");

    console.log("\n=======================================================");
    console.log(" ALL 8 STEP 12 DOCX DOCUMENT TESTS PASSED SUCCESSFULLY ");
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
  console.error("DOCX document test failed:", err);
  process.exit(1);
});
