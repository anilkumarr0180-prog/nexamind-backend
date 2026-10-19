import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import { ATTACHMENT_STATUSES, ATTACHMENT_TYPES } from "../src/modules/attachments/attachment.types.js";
import { DocumentChunk } from "../src/modules/attachments/document-chunk.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { cloudinary } from "../src/config/cloudinary.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as messageRepository from "../src/modules/messages/message.repository.js";

const runTests = async () => {
  console.log("=== Starting Conversation Deletion Lifecycle Regression Tests ===");

  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}/api/v1`;

  // Track Cloudinary deletions
  const destroyedPublicIds: string[] = [];
  const originalDestroy = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async (publicId: string) => {
    destroyedPublicIds.push(publicId);
    return { result: "ok" } as any;
  };

  let userA: any = null;
  let userB: any = null;
  let tokenA = "";
  let tokenB = "";

  try {
    // 1. Setup Test Users
    userA = await User.create({
      name: "User Delete A",
      email: `delete.user.a.${Date.now()}@example.com`,
      passwordHash: "dummyhash123",
    });
    tokenA = generateAccessToken({ sub: userA._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userA._id, balance: 50 });

    userB = await User.create({
      name: "User Delete B",
      email: `delete.user.b.${Date.now()}@example.com`,
      passwordHash: "dummyhash123",
    });
    tokenB = generateAccessToken({ sub: userB._id.toString(), roles: ["USER"] });
    await TokenBalance.create({ userId: userB._id, balance: 50 });

    // -------------------------------------------------------------------------
    // Test 1: Successful Deletion of Conversation Messages
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Testing successful deletion of conversation messages...");
    const conv1 = await Conversation.create({
      userId: userA._id,
      title: "Conversation With Messages",
      status: "ACTIVE",
      messageCount: 3,
      summary: "Active discussion on database lifecycle",
      summaryUpdatedAt: new Date(),
    });

    const msg1 = await Message.create({
      conversationId: conv1._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Hello NexaMind, please analyze this code.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    const msg2 = await Message.create({
      conversationId: conv1._id,
      userId: userA._id,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Here is the code analysis and recommendation.",
      status: MESSAGE_STATUSES.COMPLETED,
      parentMessageId: msg1._id,
    });

    const msg3 = await Message.create({
      conversationId: conv1._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Understood, thank you.",
      status: MESSAGE_STATUSES.COMPLETED,
      parentMessageId: msg2._id,
    });

    await Conversation.findByIdAndUpdate(conv1._id, { activeLeafMessageId: msg3._id });

    // Verify messages exist before deletion
    const beforeMsgs = await Message.find({ conversationId: conv1._id });
    assert.strictEqual(beforeMsgs.length, 3, "Expected 3 messages before deletion");

    // Execute deletion via API
    const delRes1 = await fetch(`${baseUrl}/conversations/${conv1._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(delRes1.status, 200, "DELETE conversation must return 200");
    const delJson1 = (await delRes1.json()) as any;
    assert.strictEqual(delJson1.success, true);

    // Verify message documents are permanently deleted from MongoDB
    const afterMsgs = await Message.find({ conversationId: conv1._id });
    assert.strictEqual(afterMsgs.length, 0, "All message documents must be permanently deleted from MongoDB");

    // Verify conversation record is minimally soft-deleted and content summaries wiped
    const updatedConv1 = await Conversation.findById(conv1._id);
    assert.ok(updatedConv1, "Conversation record should exist in soft-deleted state");
    assert.ok(updatedConv1.deletedAt instanceof Date, "deletedAt must be set");
    assert.strictEqual(updatedConv1.summary, null, "Summary must be wiped to null");
    assert.strictEqual(updatedConv1.summaryUpdatedAt, null, "summaryUpdatedAt must be wiped to null");
    assert.strictEqual(updatedConv1.activeLeafMessageId, null, "activeLeafMessageId must be wiped to null");
    assert.strictEqual(updatedConv1.messageCount, 0, "messageCount must be reset to 0");
    console.log("✓ Messages permanently removed and conversation metadata purged");

    // -------------------------------------------------------------------------
    // Test 2: User Cannot Delete Another User's Conversation (Ownership Check)
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Testing cross-user conversation deletion rejection...");
    const convA_private = await Conversation.create({
      userId: userA._id,
      title: "User A Private Discussion",
      status: "ACTIVE",
    });

    await Message.create({
      conversationId: convA_private._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Confidential financial plan",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // User B attempts to delete User A's conversation
    const unauthorizedDel = await fetch(`${baseUrl}/conversations/${convA_private._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(unauthorizedDel.status, 404, "Cross-user delete must return 404 CONVERSATION_NOT_FOUND");
    const unauthorizedJson = (await unauthorizedDel.json()) as any;
    assert.strictEqual(unauthorizedJson.error.code, "CONVERSATION_NOT_FOUND");

    // Verify User A's conversation and messages were NOT deleted
    const checkConvA = await Conversation.findById(convA_private._id);
    assert.strictEqual(checkConvA?.deletedAt, null, "User A conversation must remain untouched");
    const checkMsgsA = await Message.find({ conversationId: convA_private._id });
    assert.strictEqual(checkMsgsA.length, 1, "User A messages must remain intact");
    console.log("✓ Cross-user conversation deletion strictly rejected with 404 and data preserved");

    // -------------------------------------------------------------------------
    // Test 3: Deleted Messages Do Not Reappear in History or Agent Retrieval
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Testing deleted messages do not reappear in history or agent context...");
    // 3a. GET /conversations/:id/messages
    const historyRes = await fetch(`${baseUrl}/conversations/${conv1._id.toString()}/messages`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(historyRes.status, 404, "History endpoint must return 404 for deleted conversation");

    // 3b. GET /conversations/:id
    const singleConvRes = await fetch(`${baseUrl}/conversations/${conv1._id.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(singleConvRes.status, 404, "GET /conversations/:id must return 404 for deleted conversation");

    // 3c. Agent run referencing deleted conversation
    const agentRes = await fetch(`${baseUrl}/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        task: "Continue from our previous turn",
        conversationId: conv1._id.toString(),
      }),
    });
    assert.strictEqual(agentRes.status, 404, "Agent execution referencing deleted conversation must return 404");
    console.log("✓ Deleted messages and conversations inaccessible to history and AI agent");

    // -------------------------------------------------------------------------
    // Test 4: Attachment and Vector-Chunk Cleanup Continues to Work
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Testing attachment and vector-chunk cleanup during conversation deletion...");
    const convWithAtt = await Conversation.create({
      userId: userA._id,
      title: "Conversation With Attachments",
      status: "ACTIVE",
    });

    const att1 = await Attachment.create({
      userId: userA._id,
      conversationId: convWithAtt._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "architecture.pdf",
      mimeType: "application/pdf",
      size: 1024,
      cloudinaryPublicId: `nexamind/test/lifecycle_pdf_${Date.now()}`,
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/test.pdf",
      status: ATTACHMENT_STATUSES.READY,
    });

    const chunk1 = await DocumentChunk.create({
      attachmentId: att1._id,
      chunkIndex: 0,
      text: "Section 1: Architecture diagram and microservice design",
      embedding: [0.1, 0.2, 0.3],
    });

    const msgWithAtt = await Message.create({
      conversationId: convWithAtt._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Please read the attached architecture document",
      attachmentId: att1._id,
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // Delete conversation
    const delAttRes = await fetch(`${baseUrl}/conversations/${convWithAtt._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(delAttRes.status, 200, "DELETE conversation with attachments must return 200");

    // Verify Cloudinary destroyed
    assert.ok(destroyedPublicIds.includes(att1.cloudinaryPublicId!), "Cloudinary destroy must be called");

    // Verify MongoDB Attachment and DocumentChunk collections are cleaned up
    const remainingAtt = await Attachment.findById(att1._id);
    assert.strictEqual(remainingAtt, null, "Attachment document must be deleted from MongoDB");

    const remainingChunks = await DocumentChunk.find({ attachmentId: att1._id });
    assert.strictEqual(remainingChunks.length, 0, "Document chunks must be deleted from MongoDB");

    // Verify Message is also deleted
    const remainingMsg = await Message.findById(msgWithAtt._id);
    assert.strictEqual(remainingMsg, null, "Message referencing attachment must be deleted");
    console.log("✓ Attachments, Cloudinary assets, vector chunks, and messages cleaned up in cascade");

    // -------------------------------------------------------------------------
    // Test 5: Repeated Deletion Requests Behave Safely & Idempotently
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Testing repeated deletion idempotency...");
    const repeatDel1 = await fetch(`${baseUrl}/conversations/${conv1._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(repeatDel1.status, 200, "Repeated delete must return 200 OK");
    const repeatJson1 = (await repeatDel1.json()) as any;
    assert.strictEqual(repeatJson1.success, true);
    assert.ok(repeatJson1.data.deletedAt, "Returned object should contain deletedAt timestamp");

    // Third call
    const repeatDel2 = await fetch(`${baseUrl}/conversations/${conv1._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(repeatDel2.status, 200, "Third repeated delete must return 200 OK");
    console.log("✓ Repeated deletion calls are safe and idempotent");

    // -------------------------------------------------------------------------
    // Test 6: Cognitive Memories Are Preserved (Independent Lifecycle)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Testing user cognitive memories are not deleted...");
    const mem1 = await Memory.create({
      userId: userA._id,
      type: MEMORY_TYPES.PREFERENCE,
      content: "User prefers TypeScript and functional programming style",
      status: MEMORY_STATUSES.ACTIVE,
    });

    // Delete another conversation for User A
    const convForMemoryTest = await Conversation.create({
      userId: userA._id,
      title: "Temporary conversation before memory check",
      status: "ACTIVE",
    });
    await fetch(`${baseUrl}/conversations/${convForMemoryTest._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    // Verify Memory is still ACTIVE and intact
    const checkMem = await Memory.findById(mem1._id);
    assert.ok(checkMem, "Memory must still exist");
    assert.strictEqual(checkMem.status, MEMORY_STATUSES.ACTIVE, "Memory must remain ACTIVE");
    assert.strictEqual(checkMem.deletedAt, null, "Memory deletedAt must remain null");
    console.log("✓ Cognitive memories independently preserved without collateral deletion");

    // -------------------------------------------------------------------------
    // Test 7: Database Failure Handling
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Testing database failure handling (no silent false success)...");
    const convFailTest = await Conversation.create({
      userId: userA._id,
      title: "Conv for DB Failure Test",
      status: "ACTIVE",
    });

    // Stub Message.deleteMany to simulate a database failure
    const originalDeleteMany = Message.deleteMany;
    (Message as any).deleteMany = async () => {
      throw new Error("Simulated MongoDB write failure during message purge");
    };

    try {
      await assert.rejects(
        async () => {
          await conversationService.deleteConversation(convFailTest._id.toString(), userA._id.toString());
        },
        /Simulated MongoDB write failure/,
        "Service must throw when database message purge fails, rather than silently succeeding",
      );
      console.log("✓ Database failure correctly propagated without reporting false success");
    } finally {
      (Message as any).deleteMany = originalDeleteMany;
    }

    // -------------------------------------------------------------------------
    // Test 8: Transient Cloudinary Failure Preserves Attachment Record & Asset ID
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Testing transient Cloudinary failure preserves attachment record & halts deletion...");
    const convCloudFail = await Conversation.create({
      userId: userA._id,
      title: "Conv for Cloudinary Failure Test",
      status: "ACTIVE",
    });

    const attCloudFail = await Attachment.create({
      userId: userA._id,
      conversationId: convCloudFail._id,
      type: ATTACHMENT_TYPES.IMAGE,
      originalName: "screenshot.png",
      mimeType: "image/png",
      size: 2048,
      cloudinaryPublicId: `nexamind/test/fail_transient_${Date.now()}`,
      secureUrl: "https://res.cloudinary.com/demo/image/upload/screenshot.png",
      status: ATTACHMENT_STATUSES.READY,
    });

    await Message.create({
      conversationId: convCloudFail._id,
      userId: userA._id,
      role: MESSAGE_ROLES.USER,
      content: "Look at this screenshot",
      attachmentId: attCloudFail._id,
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // Simulate transient Cloudinary outage / 503 error
    cloudinary.uploader.destroy = async () => {
      throw new Error("Cloudinary connection reset / timeout: 503 Service Unavailable");
    };

    const failRes = await fetch(`${baseUrl}/conversations/${convCloudFail._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(failRes.status, 502, "Failed Cloudinary deletion must return HTTP 502");
    const failJson = (await failRes.json()) as any;
    assert.strictEqual(failJson.error.code, "CLOUDINARY_DELETE_FAILED");

    // Invariant check: Attachment record and its cloudinaryPublicId MUST remain in MongoDB
    const preservedAtt = await Attachment.findById(attCloudFail._id);
    assert.ok(preservedAtt, "Attachment record must be preserved in MongoDB after Cloudinary failure");
    assert.strictEqual(
      preservedAtt.cloudinaryPublicId,
      attCloudFail.cloudinaryPublicId,
      "cloudinaryPublicId must remain intact for retry",
    );

    // Invariant check: Messages must NOT be purged
    const preservedMsgs = await Message.find({ conversationId: convCloudFail._id });
    assert.strictEqual(preservedMsgs.length, 1, "Messages must NOT be purged when external cleanup fails");

    // Invariant check: Conversation must NOT be soft-deleted
    const preservedConv = await Conversation.findById(convCloudFail._id);
    assert.strictEqual(preservedConv?.deletedAt, null, "Conversation must remain active when cleanup fails");
    console.log("✓ Cloudinary failure halted deletion safely, preserving attachment record and publicId");

    // -------------------------------------------------------------------------
    // Test 9: Subsequent Retry Completes Deletion Successfully
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Testing subsequent retry after Cloudinary recovery...");
    // Restore Cloudinary service to healthy state
    cloudinary.uploader.destroy = async (publicId: string) => {
      destroyedPublicIds.push(publicId);
      return { result: "ok" } as any;
    };

    const retryRes = await fetch(`${baseUrl}/conversations/${convCloudFail._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(retryRes.status, 200, "Retry must succeed with 200 once Cloudinary is healthy");
    const retryJson = (await retryRes.json()) as any;
    assert.strictEqual(retryJson.success, true);

    // Verify Cloudinary asset destroyed
    assert.ok(
      destroyedPublicIds.includes(attCloudFail.cloudinaryPublicId!),
      "Cloudinary asset must be destroyed on retry",
    );

    // Verify MongoDB Attachment is now deleted
    const retryAtt = await Attachment.findById(attCloudFail._id);
    assert.strictEqual(retryAtt, null, "Attachment must be deleted from MongoDB after successful retry");

    // Verify Messages are now deleted
    const retryMsgs = await Message.find({ conversationId: convCloudFail._id });
    assert.strictEqual(retryMsgs.length, 0, "Messages must be purged after successful retry");

    // Verify Conversation is now soft-deleted
    const retryConv = await Conversation.findById(convCloudFail._id);
    assert.ok(retryConv?.deletedAt instanceof Date, "Conversation must be marked deleted on retry");
    console.log("✓ Subsequent retry completed deletion of external asset, DB records, and messages");

    // -------------------------------------------------------------------------
    // Test 10: Already-Missing Cloudinary Asset Handled Idempotently ("not found")
    // -------------------------------------------------------------------------
    console.log("\n[Test 10] Testing already-missing Cloudinary asset (result: 'not found')...");
    const convMissingAsset = await Conversation.create({
      userId: userA._id,
      title: "Conv with Already Missing Cloud Asset",
      status: "ACTIVE",
    });

    const attMissing = await Attachment.create({
      userId: userA._id,
      conversationId: convMissingAsset._id,
      type: ATTACHMENT_TYPES.IMAGE,
      originalName: "already_deleted.png",
      mimeType: "image/png",
      size: 1024,
      cloudinaryPublicId: `nexamind/test/not_found_${Date.now()}`,
      secureUrl: "https://res.cloudinary.com/demo/image/upload/already_deleted.png",
      status: ATTACHMENT_STATUSES.READY,
    });

    // Cloudinary returns "not found" when asset is already gone
    cloudinary.uploader.destroy = async (publicId: string) => {
      destroyedPublicIds.push(publicId);
      return { result: "not found" } as any;
    };

    const notFoundDelRes = await fetch(`${baseUrl}/conversations/${convMissingAsset._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(notFoundDelRes.status, 200, "Asset already absent on Cloudinary must succeed (200)");
    const notFoundAtt = await Attachment.findById(attMissing._id);
    assert.strictEqual(notFoundAtt, null, "MongoDB attachment must be deleted when asset is confirmed absent");
    console.log("✓ Already-missing Cloudinary asset verified absent and cleaned up idempotently");

    // -------------------------------------------------------------------------
    // Test 11: Multiple Attachments: Earlier Succeeds, Later Fails, Then Retried
    // -------------------------------------------------------------------------
    console.log("\n[Test 11] Testing multiple attachments partial failure and resumption...");
    const convMultiAtt = await Conversation.create({
      userId: userA._id,
      title: "Conv with Two Attachments",
      status: "ACTIVE",
    });

    const attEarly = await Attachment.create({
      userId: userA._id,
      conversationId: convMultiAtt._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "first.pdf",
      mimeType: "application/pdf",
      size: 1024,
      cloudinaryPublicId: `nexamind/test/multi_first_${Date.now()}`,
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/first.pdf",
      status: ATTACHMENT_STATUSES.READY,
    });

    const attLate = await Attachment.create({
      userId: userA._id,
      conversationId: convMultiAtt._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "second.pdf",
      mimeType: "application/pdf",
      size: 2048,
      cloudinaryPublicId: `nexamind/test/multi_second_${Date.now()}`,
      secureUrl: "https://res.cloudinary.com/demo/raw/upload/second.pdf",
      status: ATTACHMENT_STATUSES.READY,
    });

    // attEarly succeeds, but attLate fails
    cloudinary.uploader.destroy = async (publicId: string) => {
      destroyedPublicIds.push(publicId);
      if (publicId === attLate.cloudinaryPublicId) {
        throw new Error("Simulated Cloudinary rate limit: 429 Too Many Requests");
      }
      return { result: "ok" } as any;
    };

    const partialDelRes = await fetch(`${baseUrl}/conversations/${convMultiAtt._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(partialDelRes.status, 502, "Partial failure must return 502");

    // attEarly was successfully destroyed and deleted from MongoDB
    const checkEarly = await Attachment.findById(attEarly._id);
    assert.strictEqual(checkEarly, null, "attEarly must be deleted from MongoDB since Cloudinary succeeded");

    // attLate failed and MUST still exist in MongoDB
    const checkLate = await Attachment.findById(attLate._id);
    assert.ok(checkLate, "attLate must remain in MongoDB since its Cloudinary deletion failed");

    // Conversation must still be active
    const checkMultiConv = await Conversation.findById(convMultiAtt._id);
    assert.strictEqual(checkMultiConv?.deletedAt, null, "Conversation must remain active on partial failure");

    // Now restore healthy Cloudinary and retry
    cloudinary.uploader.destroy = async (publicId: string) => {
      destroyedPublicIds.push(publicId);
      return { result: "ok" } as any;
    };

    const multiRetryRes = await fetch(`${baseUrl}/conversations/${convMultiAtt._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(multiRetryRes.status, 200, "Retry must succeed once late attachment succeeds");
    const checkLateAfterRetry = await Attachment.findById(attLate._id);
    assert.strictEqual(checkLateAfterRetry, null, "attLate must be deleted after retry succeeds");
    console.log("✓ Partial multi-attachment failure saved progress and resumed cleanly on retry");

    // -------------------------------------------------------------------------
    // Test 12: Attachments Without Cloudinary PublicId Clean Up Safely
    // -------------------------------------------------------------------------
    console.log("\n[Test 12] Testing attachment without Cloudinary public ID cleans up safely...");
    const convLocalOnly = await Conversation.create({
      userId: userA._id,
      title: "Conv with Local Attachment",
      status: "ACTIVE",
    });

    // Insert directly to bypass Mongoose schema requirement of cloudinaryPublicId (simulating local/legacy records)
    const insertRes = await Attachment.collection.insertOne({
      userId: userA._id,
      conversationId: convLocalOnly._id,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: "local_notes.txt",
      mimeType: "text/plain",
      size: 512,
      secureUrl: "https://local-placeholder/notes.txt",
      status: ATTACHMENT_STATUSES.READY,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const attLocalId = insertRes.insertedId;

    const localChunk = await DocumentChunk.create({
      attachmentId: attLocalId,
      chunkIndex: 0,
      text: "Local text content without external storage",
      embedding: [0.5, 0.6],
    });

    const localDelRes = await fetch(`${baseUrl}/conversations/${convLocalOnly._id.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    assert.strictEqual(localDelRes.status, 200, "Local-only attachment must delete cleanly with 200");
    const checkLocalAtt = await Attachment.findById(attLocalId);
    assert.strictEqual(checkLocalAtt, null, "Local attachment must be deleted from MongoDB");
    const checkLocalChunk = await DocumentChunk.findById(localChunk._id);
    assert.strictEqual(checkLocalChunk, null, "Local chunk must be deleted from MongoDB");
    console.log("✓ Attachment without Cloudinary public ID cleaned up local records safely");
  } finally {
    // Restore mocks
    cloudinary.uploader.destroy = originalDestroy;

    // Cleanup all test documents
    try {
      if (userA || userB) {
        const uids = [userA?._id, userB?._id].filter(Boolean);
        await Attachment.deleteMany({ userId: { $in: uids } });
        await DocumentChunk.deleteMany({ userId: { $in: uids } });
        await Memory.deleteMany({ userId: { $in: uids } });
        await Message.deleteMany({ userId: { $in: uids } });
        await Conversation.deleteMany({ userId: { $in: uids } });
        await TokenBalance.deleteMany({ userId: { $in: uids } });
        await User.deleteMany({ _id: { $in: uids } });
      }
    } catch (cleanupErr) {
      console.warn("Test cleanup warning:", cleanupErr);
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
