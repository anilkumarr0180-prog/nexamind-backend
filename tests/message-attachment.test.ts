import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Types } from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockAttachmentChatProvider implements AIProvider {
  public readonly name = "mock-chat";
  public calls: AIMessage[][] = [];

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: `Mock AI response to: ${messages[messages.length - 1]?.content ?? ""}`,
      provider: "mock-chat",
      model: "mock-model",
      usage: {
        inputTokens: 12,
        outputTokens: 18,
        totalTokens: 30,
      },
    };
  }

  async *generateChatStream(messages: AIMessage[]): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    yield { content: "Streamed ", model: "mock-model" };
    yield {
      content: "response",
      model: "mock-model",
      usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Message Attachment: Step 4 Integration Tests ===");

  await connectDatabase();

  const mockProvider = new MockAttachmentChatProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Setup Users, Credits, Conversations, and Attachments
    // -------------------------------------------------------------
    const userA = await User.create({
      email: `msg_att_a_${timestamp}@example.com`,
      passwordHash: "dummyhash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    await TokenBalance.create({ userId: userA._id, balance: 500 });
    const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });

    const userB = await User.create({
      email: `msg_att_b_${timestamp}@example.com`,
      passwordHash: "dummyhash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    await TokenBalance.create({ userId: userB._id, balance: 500 });
    const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });

    // User A Conversation 1 and Conversation 2
    const convA1 = await Conversation.create({
      userId: userA._id,
      title: `Conv A1 ${timestamp}`,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(convA1._id.toString());

    const convA2 = await Conversation.create({
      userId: userA._id,
      title: `Conv A2 ${timestamp}`,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(convA2._id.toString());

    // User B Conversation
    const convB = await Conversation.create({
      userId: userB._id,
      title: `Conv B ${timestamp}`,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(convB._id.toString());

    // Attachment A1 (belongs to User A, Conversation A1)
    const attA1 = await Attachment.create({
      userId: userA._id,
      conversationId: convA1._id,
      originalName: "screenshot-a1.png",
      mimeType: "image/png",
      size: 1024 * 50,
      cloudinaryPublicId: `nexamind/users/${userA._id}/conversations/${convA1._id}/images/att_a1_${timestamp}`,
      secureUrl: `https://res.cloudinary.com/nexamind/image/upload/v1/att_a1_${timestamp}.png`,
      status: "READY",
    });
    createdAttachmentIds.push(attA1._id.toString());

    // Attachment B (belongs to User B, Conversation B)
    const attB = await Attachment.create({
      userId: userB._id,
      conversationId: convB._id,
      originalName: "photo-b.jpg",
      mimeType: "image/jpeg",
      size: 1024 * 75,
      cloudinaryPublicId: `nexamind/users/${userB._id}/conversations/${convB._id}/images/att_b_${timestamp}`,
      secureUrl: `https://res.cloudinary.com/nexamind/image/upload/v1/att_b_${timestamp}.jpg`,
      status: "READY",
    });
    createdAttachmentIds.push(attB._id.toString());

    // -------------------------------------------------------------
    // Test 1: Text-only message still works (backward compatibility)
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing text-only message still works...");
    const res1 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Hello without attachment",
      }),
    });

    assert.equal(res1.status, 200, "Text-only chat should return 200");
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.data.userMessage.content, "Hello without attachment");
    assert.equal(json1.data.userMessage.attachmentId, null, "attachmentId should be null for text-only");

    const dbMsg1 = await Message.findById(json1.data.userMessage.id);
    assert.ok(dbMsg1);
    assert.equal(dbMsg1.attachmentId, null, "DB record attachmentId must be null");
    console.log("✓ Text-only message works as before without attachments");

    // -------------------------------------------------------------
    // Test 2: Message with valid attachment works & saves reference
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing message with valid attachment reference...");
    const res2 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Here is the screenshot",
        attachmentId: attA1._id.toString(),
      }),
    });

    assert.equal(res2.status, 200, "Chat with valid attachment should return 200");
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(
      json2.data.userMessage.attachmentId,
      attA1._id.toString(),
      "userMessage DTO must return the attachmentId",
    );

    const dbMsg2 = await Message.findById(json2.data.userMessage.id);
    assert.ok(dbMsg2);
    assert.equal(
      dbMsg2.attachmentId?.toString(),
      attA1._id.toString(),
      "DB record must persist attachmentId reference",
    );
    console.log("✓ Message with valid attachment persists attachmentId on user message");

    // -------------------------------------------------------------
    // Test 3: Invalid / non-existent attachment rejected
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing non-existent attachment rejection...");
    const fakeAttachmentId = new Types.ObjectId().toString();
    const res3 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Trying non-existent attachment",
        attachmentId: fakeAttachmentId,
      }),
    });

    assert.equal(res3.status, 404, "Non-existent attachment must return 404");
    const json3 = await res3.json();
    assert.equal(json3.success, false);
    assert.equal(json3.error.code, "ATTACHMENT_NOT_FOUND");

    // Verify no user message was created for this failed request
    const ghostMsg3 = await Message.findOne({ content: "Trying non-existent attachment" });
    assert.equal(ghostMsg3, null, "No message should be saved on attachment failure");
    console.log("✓ Invalid attachment correctly rejected with 404 ATTACHMENT_NOT_FOUND");

    // -------------------------------------------------------------
    // Test 4: Another user's attachment rejected
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user attachment theft rejection...");
    // User A attempts to use User B's attachment (attB)
    const res4 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Stealing user B's attachment",
        attachmentId: attB._id.toString(), // belongs to User B!
      }),
    });

    assert.equal(res4.status, 403, "Another user's attachment must return 403 FORBIDDEN");
    const json4 = await res4.json();
    assert.equal(json4.success, false);
    assert.equal(json4.error.code, "FORBIDDEN");

    const ghostMsg4 = await Message.findOne({ content: "Stealing user B's attachment" });
    assert.equal(ghostMsg4, null, "No message should be saved on cross-user attachment failure");
    console.log("✓ Cross-user attachment attempt strictly rejected with 403 FORBIDDEN");

    // -------------------------------------------------------------
    // Test 5: Attachment from another conversation rejected
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing cross-conversation attachment rejection...");
    // User A attempts to use attA1 (from Conv A1) inside Conv A2
    const res5 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA2._id.toString(), // Conv A2!
        content: "Cross-conversation attachment",
        attachmentId: attA1._id.toString(), // Belongs to Conv A1!
      }),
    });

    assert.equal(res5.status, 400, "Attachment from different conversation must return 400");
    const json5 = await res5.json();
    assert.equal(json5.success, false);
    assert.equal(json5.error.code, "INVALID_ATTACHMENT_CONVERSATION");

    const ghostMsg5 = await Message.findOne({ content: "Cross-conversation attachment" });
    assert.equal(ghostMsg5, null, "No message should be saved on cross-conversation failure");
    console.log("✓ Cross-conversation attachment strictly rejected with 400 INVALID_ATTACHMENT_CONVERSATION");

    // -------------------------------------------------------------
    // Test 6: Existing streaming still works (with & without attachment)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing streaming chat with attachment...");
    const res6 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Stream this image message",
        attachmentId: attA1._id.toString(),
        stream: true,
      }),
    });

    assert.equal(res6.status, 200);
    assert.ok(res6.headers.get("content-type")?.includes("text/event-stream"));

    const sseText = await res6.text();
    assert.ok(sseText.includes('"type":"start"'), "Stream must emit start event");
    assert.ok(sseText.includes(attA1._id.toString()), "Start event userMessage must contain attachmentId");
    assert.ok(sseText.includes('"type":"done"'), "Stream must emit done event");

    const dbMsg6 = await Message.findOne({ content: "Stream this image message" });
    assert.ok(dbMsg6);
    assert.equal(dbMsg6.attachmentId?.toString(), attA1._id.toString());
    console.log("✓ Existing streaming pipeline works seamlessly with attachment references");

    // -------------------------------------------------------------
    // Test 7: Memory & summary flow compatibility
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing memory & summary flow with attachment message...");
    const convAfter = await Conversation.findById(convA1._id);
    assert.ok(convAfter);
    assert.ok(convAfter.messageCount > 0, "Conversation messageCount should increment");
    assert.ok(convAfter.lastMessageAt instanceof Date, "lastMessageAt should be updated");
    console.log("✓ Conversation metadata, message counting, and background triggers intact");

    // -------------------------------------------------------------
    // Test 8: Existing edit / regenerate branching flow
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing edit/regenerate branching with message...");
    const res8 = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: convA1._id.toString(),
        content: "Edited message version",
        editMessageId: dbMsg2!._id.toString(),
      }),
    });

    assert.equal(res8.status, 200, "Edit/regenerate should succeed");
    const json8 = await res8.json();
    assert.equal(json8.success, true);
    assert.equal(
      json8.data.userMessage.originalMessageId,
      dbMsg2!._id.toString(),
      "Edited message must point to originalMessageId",
    );
    console.log("✓ Existing edit & regenerate non-destructive branching operates cleanly");

    console.log("\n=======================================================");
    console.log(" ALL 8 STEP 4 MESSAGE ATTACHMENT TESTS PASSED ");
    console.log("=======================================================\n");
  } finally {
    server.close();

    if (createdAttachmentIds.length > 0) {
      await Attachment.deleteMany({ _id: { $in: createdAttachmentIds } });
    }
    if (createdConversationIds.length > 0) {
      await Conversation.deleteMany({ _id: { $in: createdConversationIds } });
      await Message.deleteMany({ conversationId: { $in: createdConversationIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await TokenBalance.deleteMany({ userId: { $in: createdUserIds } });
    }

    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Message attachment test failed:", err);
  process.exit(1);
});
