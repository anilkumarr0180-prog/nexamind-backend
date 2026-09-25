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
import { cloudinary } from "../src/config/cloudinary.js";

const runTests = async () => {
  console.log("=== Starting Attachment Lifecycle Cleanup: Step 7 Automated Tests ===");

  await connectDatabase();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = "http://localhost:" + port + "/api/v1";

  // Spy on cloudinary.uploader.destroy
  const destroyedPublicIds: string[] = [];
  const originalDestroy = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async (publicId: string, options?: any) => {
    destroyedPublicIds.push(publicId);
    return { result: "ok" } as any;
  };

  // Setup Test Users
  const userA = await User.create({
    name: "User Lifecycle A",
    email: "lifecycle.a." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userA._id, balance: 10 });

  const userB = await User.create({
    name: "User Lifecycle B",
    email: "lifecycle.b." + Date.now() + "@example.com",
    passwordHash: "dummyhash",
  });
  const tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
  await TokenBalance.create({ userId: userB._id, balance: 10 });

  // Setup Conversations
  const convA = await Conversation.create({
    userId: userA._id,
    title: "Lifecycle Conv A",
    status: "ACTIVE",
  });

  const convB = await Conversation.create({
    userId: userB._id,
    title: "Lifecycle Conv B",
    status: "ACTIVE",
  });

  try {
    // -------------------------------------------------------------
    // TEST 1: Authorized unreferenced attachment deletion
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing authorized unreferenced attachment deletion...");
    destroyedPublicIds.length = 0;
    const unrefAttachment = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      originalName: "unreferenced-test.png",
      mimeType: "image/png",
      size: 1024,
      cloudinaryPublicId: "nexamind/test/unref_pub_id_123",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/unref.png",
      status: "READY",
    });

    const delRes1 = await fetch(baseUrl + "/attachments/" + unrefAttachment._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(delRes1.status, 200, "Should return 200 OK");
    const data1 = (await delRes1.json()) as any;
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.data.deleted, true);

    // Verify Cloudinary destroy was called
    assert.ok(destroyedPublicIds.includes("nexamind/test/unref_pub_id_123"), "Cloudinary destroy must be called with publicId");

    // Verify MongoDB Attachment record is deleted
    const checkMongo1 = await Attachment.findById(unrefAttachment._id);
    assert.strictEqual(checkMongo1, null, "MongoDB record must be deleted");
    console.log("✓ Authorized attachment permanently deleted from Cloudinary and MongoDB");

    // -------------------------------------------------------------
    // TEST 2: Unauthorized deletion rejected with 403 Forbidden
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing unauthorized attachment deletion rejected...");
    const userBAttachment = await Attachment.create({
      userId: userB._id,
      conversationId: convB._id,
      originalName: "userB-private.png",
      mimeType: "image/png",
      size: 2048,
      cloudinaryPublicId: "nexamind/test/userb_private_pub_id",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/userB.png",
      status: "READY",
    });

    const unauthRes = await fetch(baseUrl + "/attachments/" + userBAttachment._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA }, // User A tries to delete User B attachment
    });
    assert.strictEqual(unauthRes.status, 403, "Must return 403 FORBIDDEN");

    // Verify User B attachment is still in MongoDB
    const checkMongo2 = await Attachment.findById(userBAttachment._id);
    assert.ok(checkMongo2, "User B attachment must NOT be deleted");
    console.log("✓ Unauthorized attachment deletion strictly rejected with 403 FORBIDDEN");

    // -------------------------------------------------------------
    // TEST 3: Missing attachment handled safely (idempotent)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing missing attachment handled safely (idempotent)...");
    const fakeId = new Types.ObjectId().toString();
    const missingRes = await fetch(baseUrl + "/attachments/" + fakeId, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(missingRes.status, 200, "Should return 200 OK for idempotent deletion");
    const data3 = (await missingRes.json()) as any;
    assert.strictEqual(data3.success, true);
    assert.strictEqual(data3.data.deleted, false, "deleted should be false for non-existent record");
    console.log("✓ Missing attachment handled safely and idempotently without crashing");

    // -------------------------------------------------------------
    // TEST 4: Referenced attachment is not prematurely deleted directly
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing referenced attachment is protected against premature deletion...");
    const referencedAtt = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      originalName: "active-reference.png",
      mimeType: "image/png",
      size: 4096,
      cloudinaryPublicId: "nexamind/test/active_ref_pub_id",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/active.png",
      status: "READY",
    });

    const refMsg = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "This message references active-reference.png",
      attachmentId: referencedAtt._id,
    });

    const refDelRes = await fetch(baseUrl + "/attachments/" + referencedAtt._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(refDelRes.status, 400, "Should return 400 ATTACHMENT_IN_USE");
    const refCheck = await Attachment.findById(referencedAtt._id);
    assert.ok(refCheck, "Referenced attachment must not be deleted while referenced");
    console.log("✓ Direct deletion blocked with 400 ATTACHMENT_IN_USE while attachment is in use");

    // -------------------------------------------------------------
    // TEST 5: Message deletion cleanup with Edit/Regenerate version protection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing message deletion cleanup with edit/regenerate version protection...");
    destroyedPublicIds.length = 0;
    const sharedAtt = await Attachment.create({
      userId: userA._id,
      conversationId: convA._id,
      originalName: "shared-between-versions.png",
      mimeType: "image/png",
      size: 3000,
      cloudinaryPublicId: "nexamind/test/shared_version_pub_id",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/shared.png",
      status: "READY",
    });

    // Message Version 1 references sharedAtt
    const msgV1 = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Version 1 prompt",
      attachmentId: sharedAtt._id,
    });

    // Message Version 2 (branch/edit) also references sharedAtt
    const msgV2 = await Message.create({
      conversationId: convA._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Version 2 edited prompt",
      attachmentId: sharedAtt._id,
      originalMessageId: msgV1._id,
    });

    // Delete Version 2
    const delMsgV2Res = await fetch(baseUrl + "/messages/" + msgV2._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(delMsgV2Res.status, 200, "Deleting message V2 should return 200");

    // Verify msgV2 is deleted from DB
    const checkMsgV2 = await Message.findById(msgV2._id);
    assert.strictEqual(checkMsgV2, null, "Message V2 must be deleted");

    // Verify sharedAtt is NOT deleted because msgV1 still references it!
    const checkSharedAttStillThere = await Attachment.findById(sharedAtt._id);
    assert.ok(checkSharedAttStillThere, "sharedAtt must NOT be deleted because msgV1 still references it");
    assert.strictEqual(destroyedPublicIds.includes("nexamind/test/shared_version_pub_id"), false, "Cloudinary destroy must not be called yet");
    console.log("✓ Attachment preserved when another version (msgV1) still references it");

    // Now delete Version 1 (last remaining reference)
    const delMsgV1Res = await fetch(baseUrl + "/messages/" + msgV1._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(delMsgV1Res.status, 200, "Deleting message V1 should return 200");

    // Verify sharedAtt is now permanently cleaned up from Cloudinary and MongoDB!
    const checkSharedAttGone = await Attachment.findById(sharedAtt._id);
    assert.strictEqual(checkSharedAttGone, null, "sharedAtt must be cleaned up when no messages reference it");
    assert.ok(destroyedPublicIds.includes("nexamind/test/shared_version_pub_id"), "Cloudinary destroy must be called on final reference deletion");
    console.log("✓ Attachment permanently cleaned up from Cloudinary and DB when final message reference is deleted");

    // -------------------------------------------------------------
    // TEST 6: Conversation deletion cascades attachment cleanup
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing conversation deletion cascades attachment cleanup...");
    destroyedPublicIds.length = 0;
    const convCleanup = await Conversation.create({
      userId: userA._id,
      title: "Conversation to delete",
      status: "ACTIVE",
    });

    const convAtt1 = await Attachment.create({
      userId: userA._id,
      conversationId: convCleanup._id,
      originalName: "conv-att-1.png",
      mimeType: "image/png",
      size: 1500,
      cloudinaryPublicId: "nexamind/test/conv_cleanup_1",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/c1.png",
      status: "READY",
    });

    const convAtt2 = await Attachment.create({
      userId: userA._id,
      conversationId: convCleanup._id,
      originalName: "conv-att-2.png",
      mimeType: "image/png",
      size: 1800,
      cloudinaryPublicId: "nexamind/test/conv_cleanup_2",
      secureUrl: "https://res.cloudinary.com/demo/image/upload/c2.png",
      status: "READY",
    });

    const delConvRes = await fetch(baseUrl + "/conversations/" + convCleanup._id.toString(), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tokenA },
    });
    assert.strictEqual(delConvRes.status, 200, "Deleting conversation must return 200");

    // Verify both attachments were cleaned up from Cloudinary and MongoDB
    assert.ok(destroyedPublicIds.includes("nexamind/test/conv_cleanup_1"), "Cloudinary asset 1 destroyed");
    assert.ok(destroyedPublicIds.includes("nexamind/test/conv_cleanup_2"), "Cloudinary asset 2 destroyed");
    const checkAtt1 = await Attachment.findById(convAtt1._id);
    const checkAtt2 = await Attachment.findById(convAtt2._id);
    assert.strictEqual(checkAtt1, null, "Attachment 1 removed from MongoDB");
    assert.strictEqual(checkAtt2, null, "Attachment 2 removed from MongoDB");
    console.log("✓ Conversation deletion successfully cascaded attachment cleanup");

    console.log("\n>>> ALL 6 ATTACHMENT LIFECYCLE TESTS PASSED SUCCESSFULLY! <<<\n");
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
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