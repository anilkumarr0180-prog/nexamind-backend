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

const runTests = async () => {
  console.log("=== Starting Persisted Image Rendering: Step 6 Automated Tests ===");

  await connectDatabase();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = "http://localhost:" + port + "/api/v1";

  // Setup Test Users
  const userA = await User.create({
    name: "User Render A",
    email: "render.a." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userA._id, balance: 10 });

  const userB = await User.create({
    name: "User Render B",
    email: "render.b." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userB._id, balance: 10 });

  // Setup Conversations
  const convA = await Conversation.create({
    userId: userA._id,
    title: "Render Conv A",
    status: "ACTIVE",
  });

  const convB = await Conversation.create({
    userId: userB._id,
    title: "Render Conv B",
    status: "ACTIVE",
  });

  // Setup Attachments
  const attachmentA = await Attachment.create({
    userId: userA._id,
    conversationId: convA._id,
    originalName: "diagram-architecture.png",
    mimeType: "image/png",
    size: 4096,
    cloudinaryPublicId: "nexamind/users/test/diagram_secret_id",
    secureUrl: "https://res.cloudinary.com/demo/image/upload/architecture.png",
    status: "READY",
    width: 800,
    height: 600,
  });

  const attachmentB = await Attachment.create({
    userId: userB._id,
    conversationId: convB._id,
    originalName: "userB-private.png",
    mimeType: "image/png",
    size: 2048,
    cloudinaryPublicId: "nexamind/users/test/userB_secret_id",
    secureUrl: "https://res.cloudinary.com/demo/image/upload/userB-private.png",
    status: "READY",
  });

  try {
    // -------------------------------------------------------------
    // TEST 1: Text-only message unchanged
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing text-only message returns unchanged with attachment: null...");
    const textMsg = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Hello, this is pure text without attachment",
      attachmentId: null,
    });

    const res1 = await fetch(baseUrl + "/conversations/" + convA._id.toString() + "/messages", {
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(res1.status, 200, "Should return 200 OK");
    const data1 = (await res1.json()) as any;
    assert.strictEqual(data1.success, true);
    const found1 = data1.data.find((m: any) => m._id === textMsg._id.toString());
    assert.ok(found1, "Message should be found in conversation list");
    assert.strictEqual(found1.attachmentId, null, "attachmentId must be null");
    assert.strictEqual(found1.attachment, null, "attachment data must be null");
    assert.strictEqual(found1.content, "Hello, this is pure text without attachment");
    console.log("✓ Text-only message returned unchanged with attachment: null");

    // -------------------------------------------------------------
    // TEST 2: Message with attachment returns safe attachment metadata
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing message with attachment returns safe metadata without leaking credentials...");
    const visionMsg = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Check this architecture diagram",
      attachmentId: attachmentA._id,
    });

    const res2 = await fetch(baseUrl + "/conversations/" + convA._id.toString() + "/messages", {
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(res2.status, 200);
    const data2 = (await res2.json()) as any;
    const found2 = data2.data.find((m: any) => m._id === visionMsg._id.toString());
    assert.ok(found2, "Attached message should be in conversation list");
    assert.strictEqual(found2.attachmentId, attachmentA._id.toString());
    assert.ok(found2.attachment, "attachment object must be populated");
    assert.strictEqual(found2.attachment.attachmentId, attachmentA._id.toString());
    assert.strictEqual(found2.attachment.secureUrl, attachmentA.secureUrl);
    assert.strictEqual(found2.attachment.originalName, "diagram-architecture.png");
    assert.strictEqual(found2.attachment.mimeType, "image/png");
    assert.strictEqual(found2.attachment.size, 4096);
    assert.strictEqual(found2.attachment.status, "READY");
    assert.strictEqual(found2.attachment.width, 800);
    assert.strictEqual(found2.attachment.height, 600);

    // Verify NO internal credentials or secrets leaked
    assert.strictEqual(found2.attachment.cloudinaryPublicId, undefined, "cloudinaryPublicId must NOT be exposed");
    assert.strictEqual(found2.attachment.apiKey, undefined, "apiKey must NOT be exposed");
    assert.strictEqual(found2.attachment.apiSecret, undefined, "apiSecret must NOT be exposed");
    console.log("✓ Message returns safe attachment metadata and excludes internal storage credentials");

    // -------------------------------------------------------------
    // TEST 3: Unauthorized attachment is not exposed
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing cross-user / unauthorized attachment is NOT exposed...");
    // Maliciously inject User B attachmentId into User A conversation message
    const hackedMsg = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Trying to access foreign attachment",
      attachmentId: attachmentB._id, // Belongs to userB in convB!
    });

    const res3 = await fetch(baseUrl + "/conversations/" + convA._id.toString() + "/messages", {
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(res3.status, 200);
    const data3 = (await res3.json()) as any;
    const found3 = data3.data.find((m: any) => m._id === hackedMsg._id.toString());
    assert.ok(found3);
    assert.strictEqual(found3.attachment, null, "Unauthorized attachment data must NOT be exposed (attachment must be null)");
    console.log("✓ Unauthorized attachment reference strictly blocked and not exposed to other users");

    // -------------------------------------------------------------
    // TEST 4: Missing / deleted attachment does not crash chat
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing missing / deleted attachment does not crash message loading...");
    const missingId = new Types.ObjectId();
    const orphanMsg = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Message whose attachment was deleted",
      attachmentId: missingId,
    });

    const res4 = await fetch(baseUrl + "/conversations/" + convA._id.toString() + "/messages", {
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(res4.status, 200, "Missing attachment query must NOT crash and return 200 OK");
    const data4 = (await res4.json()) as any;
    const found4 = data4.data.find((m: any) => m._id === orphanMsg._id.toString());
    assert.ok(found4);
    assert.strictEqual(found4.attachment, null, "Deleted attachment gracefully returns null without crashing");
    assert.strictEqual(found4.content, "Message whose attachment was deleted");
    console.log("✓ Missing / deleted attachment handled gracefully without crashing chat");

    // -------------------------------------------------------------
    // TEST 5: Image renders after conversation reload (simulate browser refresh)
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing image renders after conversation reload (browser refresh simulation)...");
    // Reload conversation messages multiple times:
    for (let i = 1; i <= 3; i++) {
      const reloadRes = await fetch(baseUrl + "/conversations/" + convA._id.toString() + "/messages", {
        headers: { Authorization: "Bearer " + tokenA },
      });
      assert.strictEqual(reloadRes.status, 200);
      const reloadData = (await reloadRes.json()) as any;
      const reloadVisionMsg = reloadData.data.find((m: any) => m._id === visionMsg._id.toString());
      assert.ok(reloadVisionMsg?.attachment?.secureUrl, "Image URL must persist across reloads");
      assert.strictEqual(reloadVisionMsg.attachment.secureUrl, attachmentA.secureUrl);
    }
    console.log("✓ Persisted image URL remains available on reload without re-uploading");

    // -------------------------------------------------------------
    // TEST 6: Single message retrieval (GET /api/v1/messages/:messageId)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing single message endpoint returns safe attachment metadata...");
    const singleRes = await fetch(baseUrl + "/messages/" + visionMsg._id.toString(), {
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(singleRes.status, 200);
    const singleData = (await singleRes.json()) as any;
    assert.strictEqual(singleData.success, true);
    assert.ok(singleData.data.attachment);
    assert.strictEqual(singleData.data.attachment.secureUrl, attachmentA.secureUrl);
    assert.strictEqual(singleData.data.attachment.cloudinaryPublicId, undefined);
    console.log("✓ Single message retrieval endpoint successfully populates safe attachment metadata");

    console.log("\n>>> ALL 6 PERSISTED IMAGE RENDERING INTEGRATION TESTS PASSED! <<<\n");
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