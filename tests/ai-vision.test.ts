import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Types } from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { formatGroqMessages } from "../src/modules/ai/providers/groq.provider.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import { AppError } from "../src/errors/app.error.js";

class MockVisionAIProvider implements AIProvider {
  public readonly name = "mock-vision";
  public calls: AIMessage[][] = [];
  public shouldFail = false;

  async generateChatResponse(messages: AIMessage[]): Promise<AIResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    if (this.shouldFail) {
      throw new AppError("Simulated Groq Vision API failure", 502, "AI_PROVIDER_ERROR");
    }
    const last = messages[messages.length - 1];
    return {
      content: last?.imageUrl
        ? "Vision analysis of " + last.imageUrl + ": Identified image successfully."
        : "Text reply to: " + (last?.content ?? ""),
      provider: "mock-vision",
      model: "qwen/qwen3.8-27b",
      usage: {
        inputTokens: 25,
        outputTokens: 15,
        totalTokens: 40,
      },
    };
  }

  async *generateChatStream(messages: AIMessage[]): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    if (this.shouldFail) {
      throw new AppError("Simulated Groq Vision API stream failure", 502, "AI_PROVIDER_ERROR");
    }
    const last = messages[messages.length - 1];
    if (last?.imageUrl) {
      yield { content: "Streaming vision: ", model: "qwen/qwen3.8-27b" };
      yield {
        content: "Image seen!",
        model: "qwen/qwen3.8-27b",
        usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
        done: true,
      };
    } else {
      yield { content: "Streaming text: ", model: "qwen/qwen3.8-27b" };
      yield {
        content: "Done.",
        model: "qwen/qwen3.8-27b",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        done: true,
      };
    }
  }
}

const runTests = async () => {
  console.log("=== Starting AI Vision Integration: Step 5 Automated Tests ===");

  await connectDatabase();

  const mockProvider = new MockVisionAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = "http://localhost:" + port + "/api/v1";

  // 1. Setup Test Users
  const userA = await User.create({
    name: "User Vision A",
    email: "vision.a." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userA._id, balance: 10 });

  const userB = await User.create({
    name: "User Vision B",
    email: "vision.b." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userB._id, balance: 10 });

  // 2. Setup Conversations
  const convA = await Conversation.create({
    userId: userA._id,
    title: "Vision Conv A",
    status: "ACTIVE",
  });

  const convB = await Conversation.create({
    userId: userB._id,
    title: "Vision Conv B",
    status: "ACTIVE",
  });

  // 3. Setup Attachments
  const attachmentA = await Attachment.create({
    userId: userA._id,
    conversationId: convA._id,
    originalName: "test-diagram.png",
    mimeType: "image/png",
    size: 2048,
    cloudinaryPublicId: "nexamind/test/img_a",
    secureUrl: "https://res.cloudinary.com/demo/image/upload/sample.png",
    status: "READY",
  });

  const attachmentB = await Attachment.create({
    userId: userB._id,
    conversationId: convB._id,
    originalName: "userB-doc.png",
    mimeType: "image/png",
    size: 4096,
    cloudinaryPublicId: "nexamind/test/img_b",
    secureUrl: "https://res.cloudinary.com/demo/image/upload/userB.png",
    status: "READY",
  });

  try {
    // -------------------------------------------------------------
    // UNIT TEST: formatGroqMessages formatting logic
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing Groq message formatter abstraction...");
    const textOnlyAIMessages: AIMessage[] = [
      { role: "user", content: "What is 2 + 2?" },
    ];
    const formattedText = formatGroqMessages(textOnlyAIMessages);
    const userTextMsg = formattedText.find((m) => m.role === "user");
    assert.strictEqual(typeof userTextMsg?.content, "string", "Text-only message content must remain pure string");
    assert.strictEqual(userTextMsg?.content, "What is 2 + 2?");

    const visionAIMessages: AIMessage[] = [
      {
        role: "user",
        content: "What is shown in this picture?",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/sample.png",
      },
    ];
    const formattedVision = formatGroqMessages(visionAIMessages);
    const userVisionMsg = formattedVision.find((m) => m.role === "user");
    assert.ok(Array.isArray(userVisionMsg?.content), "Vision user message content must be an array of blocks");
    const blocks = userVisionMsg?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    assert.strictEqual(blocks[0]?.type, "text");
    assert.strictEqual(blocks[0]?.text, "What is shown in this picture?");
    assert.strictEqual(blocks[1]?.type, "image_url");
    assert.strictEqual(blocks[1]?.image_url?.url, "https://res.cloudinary.com/demo/image/upload/sample.png");
    console.log("✓ formatGroqMessages produces clean string for text-only and native multimodal blocks for vision");

    // -------------------------------------------------------------
    // INTEGRATION TEST: Text-only request unchanged & credits deducted exactly once
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing text-only chat request remains unchanged...");
    mockProvider.calls = [];
    const textRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Hello, this is pure text",
      }),
    });
    assert.strictEqual(textRes.status, 200, "Text-only request should return 200 OK");
    const textData = (await textRes.json()) as any;
    assert.strictEqual(textData.success, true);
    assert.strictEqual(textData.data.userMessage.attachmentId, null, "Text-only message has null attachmentId");

    // Verify provider received text without imageUrl
    const lastTextCall = mockProvider.calls[mockProvider.calls.length - 1];
    const lastTextMsg = lastTextCall?.[lastTextCall.length - 1];
    assert.strictEqual(lastTextMsg?.role, "user");
    assert.ok(lastTextMsg?.content.includes("Hello, this is pure text"));
    assert.strictEqual(lastTextMsg?.imageUrl, undefined, "No imageUrl in text-only message");

    // Check credits deducted exactly once (10 -> 9)
    const bal1 = await TokenBalance.findOne({ userId: userA._id });
    assert.strictEqual(bal1?.balance, 9, "Token balance should be 9 after 1 credit deduction");
    console.log("✓ Text-only request works unchanged, imageUrl undefined, 1 credit deducted");

    // -------------------------------------------------------------
    // INTEGRATION TEST: Valid image + text request
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing valid image + text chat request...");
    mockProvider.calls = [];
    const visionRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Describe this attached diagram",
        attachmentId: attachmentA._id.toString(),
      }),
    });
    assert.strictEqual(visionRes.status, 200, "Valid image+text request should return 200 OK");
    const visionData = (await visionRes.json()) as any;
    assert.strictEqual(visionData.success, true);
    assert.strictEqual(
      visionData.data.userMessage.attachmentId,
      attachmentA._id.toString(),
      "User message should link the attachmentId",
    );
    assert.ok(
      visionData.data.assistantMessage.content.includes("Vision analysis"),
      "Assistant message contains vision analysis",
    );

    // Verify provider received the image URL
    const lastVisionCall = mockProvider.calls.find((c) => c.some((m) => m.content.includes("Describe this attached diagram")));
    const lastVisionMsg = lastVisionCall?.[lastVisionCall.length - 1];
    assert.strictEqual(lastVisionMsg?.role, "user");
    assert.ok(lastVisionMsg?.content.includes("Describe this attached diagram"));
    assert.strictEqual(
      lastVisionMsg?.imageUrl,
      attachmentA.secureUrl,
      "Latest user message should have imageUrl from attachment record",
    );

    // Check credits deducted exactly once (9 -> 8)
    const bal2 = await TokenBalance.findOne({ userId: userA._id });
    assert.strictEqual(bal2?.balance, 8, "Token balance should be 8 after exactly 1 more credit deduction");
    console.log("✓ Valid image + text passed to provider natively, credits deducted exactly once");

    // -------------------------------------------------------------
    // SECURITY TEST: Invalid / cross-user attachment rejected
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user and cross-conversation attachment rejection...");
    // 4a. Cross-user: User A tries to attach User B attachment
    const crossUserRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Trying to steal user B image",
        attachmentId: attachmentB._id.toString(),
      }),
    });
    assert.strictEqual(crossUserRes.status, 403, "Cross-user attachment must be rejected with 403 Forbidden");

    // 4b. Cross-conversation: User A tries to attach attachment from another conversation
    const anotherConvA = await Conversation.create({
      userId: userA._id,
      title: "Another Conv A",
      status: "ACTIVE",
    });
    const crossConvRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: anotherConvA._id.toString(),
        content: "Trying cross-conversation attachment",
        attachmentId: attachmentA._id.toString(),
      }),
    });
    assert.strictEqual(crossConvRes.status, 400, "Cross-conversation attachment must be rejected with 400");

    // 4c. Non-existent attachmentId
    const fakeId = new Types.ObjectId().toString();
    const notFoundRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Non-existent attachment",
        attachmentId: fakeId,
      }),
    });
    assert.strictEqual(notFoundRes.status, 404, "Non-existent attachment must return 404 Not Found");

    // Verify token balance was NOT deducted for any rejected calls
    const balAfterRejections = await TokenBalance.findOne({ userId: userA._id });
    assert.strictEqual(balAfterRejections?.balance, 8, "Token balance must remain unchanged after rejected requests");
    console.log("✓ Cross-user, cross-conversation, and non-existent attachments strictly rejected without credit loss");

    // -------------------------------------------------------------
    // RESILIENCE TEST: Provider vision failure handled safely & credits refunded
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing provider vision failure handled safely...");
    mockProvider.shouldFail = true;

    const failRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "This vision call will fail",
        attachmentId: attachmentA._id.toString(),
      }),
    });
    assert.strictEqual(failRes.status, 502, "Provider vision failure should return 502");

    // Check credits were refunded (8 -> 7 deducted, then refunded back to 8)
    const balAfterFail = await TokenBalance.findOne({ userId: userA._id });
    assert.strictEqual(balAfterFail?.balance, 8, "Token balance should be refunded back to 8 on provider failure");

    // Check that any failed user message is marked as FAILED in DB
    const failedMsg = await Message.findOne({
      conversationId: convA._id,
      content: "This vision call will fail",
    });
    assert.ok(failedMsg, "User message should exist in DB");
    assert.strictEqual(failedMsg?.status, MESSAGE_STATUSES.FAILED, "User message status should be FAILED");
    mockProvider.shouldFail = false;
    console.log("✓ Provider vision failure safely caught, credits refunded, message marked FAILED");

    // -------------------------------------------------------------
    // STREAMING TEST: Streaming works with vision attachment
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing streaming chat with vision attachment...");
    mockProvider.calls = [];
    const streamRes = await fetch(baseUrl + "/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenA,
      },
      body: JSON.stringify({
        conversationId: convA._id.toString(),
        content: "Stream this image inspection",
        attachmentId: attachmentA._id.toString(),
        stream: true,
      }),
    });
    assert.strictEqual(streamRes.status, 200, "Streaming vision chat should return 200 OK");
    const streamText = await streamRes.text();
    assert.ok(streamText.includes("Streaming vision:"), "Stream should yield chunks");
    assert.ok(streamText.includes("Image seen!"), "Stream should contain assistant output");

    // Verify provider received imageUrl during streaming
    const lastStreamCall = mockProvider.calls.find((c) => c.some((m) => m.content.includes("Stream this image inspection")));
    const lastStreamMsg = lastStreamCall?.[lastStreamCall.length - 1];
    assert.strictEqual(lastStreamMsg?.imageUrl, attachmentA.secureUrl);

    // Verify credit deducted exactly once for stream (8 -> 7)
    const balStream = await TokenBalance.findOne({ userId: userA._id });
    assert.strictEqual(balStream?.balance, 7, "Token balance should be 7 after streaming call");
    console.log("✓ Streaming works seamlessly with vision input, credits deducted exactly once");

    console.log("\n>>> ALL 6 AI VISION INTEGRATION TESTS PASSED SUCCESSFULLY! <<<\n");
  } finally {
    await User.deleteMany({ _id: { $in: [userA._id, userB._id] } });
    await TokenBalance.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Conversation.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Message.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Attachment.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await new Promise((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});