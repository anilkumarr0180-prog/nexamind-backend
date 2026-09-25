import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { Types } from "mongoose";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as attachmentRepository from "../src/modules/attachments/attachment.repository.js";
import * as cloudinaryModule from "../src/config/cloudinary.js";
import { uploadImageAttachment } from "../src/modules/attachments/attachment.service.js";
import { MAX_ATTACHMENT_FILE_SIZE } from "../src/modules/attachments/attachment.types.js";

const runTests = async () => {
  console.log("=== Starting Attachment API: Step 2 Secure Image Upload Tests ===");

  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const cloudinaryPublicIdsToClean: string[] = [];

  // Minimal 1x1 transparent PNG buffer (valid image)
  const validPngBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  try {
    // -------------------------------------------------------------
    // Setup: Create test User A and User B with auth tokens
    // -------------------------------------------------------------
    const userA = await User.create({
      email: `attachment_user_a_${timestamp}@example.com`,
      passwordHash: "secure_dummy_hash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userA._id.toString());
    const tokenA = generateAccessToken({
      sub: userA._id.toString(),
      roles: ["USER"],
    });

    const userB = await User.create({
      email: `attachment_user_b_${timestamp}@example.com`,
      passwordHash: "secure_dummy_hash",
      status: "ACTIVE",
      roles: ["USER"],
    });
    createdUserIds.push(userB._id.toString());
    const tokenB = generateAccessToken({
      sub: userB._id.toString(),
      roles: ["USER"],
    });

    const conversationA = await Conversation.create({
      userId: userA._id,
      title: `Conversation A ${timestamp}`,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationA._id.toString());

    // -------------------------------------------------------------
    // Test 1: Successful image upload (POST /api/v1/attachments/image)
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing successful authenticated image upload...");
    const form1 = new FormData();
    form1.append(
      "file",
      new Blob([validPngBuffer], { type: "image/png" }),
      "pixel.png",
    );
    form1.append("conversationId", conversationA._id.toString());

    const res1 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      body: form1,
    });

    assert.equal(res1.status, 201, "Upload endpoint should return 201 Created");
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.ok(json1.data, "Response data should be present");

    // Requirement 9: Verify return contains strictly the 6 required fields
    const returnedKeys = Object.keys(json1.data).sort();
    const expectedKeys = [
      "attachmentId",
      "mimeType",
      "originalName",
      "secureUrl",
      "size",
      "status",
    ].sort();
    assert.deepEqual(
      returnedKeys,
      expectedKeys,
      "Response data must return strictly: attachmentId, originalName, mimeType, size, secureUrl, status",
    );

    assert.equal(json1.data.originalName, "pixel.png");
    assert.equal(json1.data.mimeType, "image/png");
    assert.equal(json1.data.size, validPngBuffer.length);
    assert.equal(json1.data.status, "READY");
    assert.ok(
      json1.data.secureUrl.startsWith("https://res.cloudinary.com/"),
      "secureUrl must be a secure HTTPS Cloudinary URL",
    );

    createdAttachmentIds.push(json1.data.attachmentId);

    // Verify database record and Requirement 6 folder path
    const dbAttachment = await Attachment.findById(json1.data.attachmentId);
    assert.ok(dbAttachment, "Attachment document must exist in MongoDB");
    assert.equal(dbAttachment.userId.toString(), userA._id.toString());
    assert.equal(
      dbAttachment.conversationId.toString(),
      conversationA._id.toString(),
    );

    const expectedFolderPrefix = `nexamind/users/${userA._id.toString()}/conversations/${conversationA._id.toString()}/images`;
    assert.ok(
      dbAttachment.cloudinaryPublicId.startsWith(expectedFolderPrefix),
      `Cloudinary folder must start with '${expectedFolderPrefix}' (got: '${dbAttachment.cloudinaryPublicId}')`,
    );

    cloudinaryPublicIdsToClean.push(dbAttachment.cloudinaryPublicId);
    console.log("✓ Successful image upload verified with exact required fields and folder structure");

    // -------------------------------------------------------------
    // Test 2: Unauthenticated request
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing unauthenticated request rejection...");
    const form2 = new FormData();
    form2.append(
      "file",
      new Blob([validPngBuffer], { type: "image/png" }),
      "pixel.png",
    );
    form2.append("conversationId", conversationA._id.toString());

    const res2 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      body: form2,
    });

    assert.equal(res2.status, 401, "Unauthenticated request must return 401");
    const json2 = await res2.json();
    assert.equal(json2.success, false);
    assert.equal(json2.error.code, "UNAUTHORIZED");
    console.log("✓ Unauthenticated request rejected with 401 UNAUTHORIZED");

    // -------------------------------------------------------------
    // Test 3: Invalid MIME type
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing invalid MIME type rejection...");
    const form3 = new FormData();
    form3.append(
      "file",
      new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }),
      "document.pdf",
    );
    form3.append("conversationId", conversationA._id.toString());

    const res3 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      body: form3,
    });

    assert.equal(res3.status, 400, "Invalid MIME type must return 400");
    const json3 = await res3.json();
    assert.equal(json3.success, false);
    assert.equal(json3.error.code, "INVALID_MIME_TYPE");
    console.log("✓ Invalid MIME type rejected with 400 INVALID_MIME_TYPE");

    // -------------------------------------------------------------
    // Test 4: Oversized file
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing oversized file rejection...");
    // Buffer > 10MB
    const oversizedBuffer = Buffer.alloc(MAX_ATTACHMENT_FILE_SIZE + 1024);
    const form4 = new FormData();
    form4.append(
      "file",
      new Blob([oversizedBuffer], { type: "image/jpeg" }),
      "giant.jpg",
    );
    form4.append("conversationId", conversationA._id.toString());

    const res4 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      body: form4,
    });

    assert.equal(res4.status, 400, "Oversized file must return 400");
    const json4 = await res4.json();
    assert.equal(json4.success, false);
    assert.equal(json4.error.code, "FILE_TOO_LARGE");
    console.log("✓ Oversized file rejected with 400 FILE_TOO_LARGE");

    // -------------------------------------------------------------
    // Test 5: Missing conversation
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing missing conversation handling...");
    // 5a. Non-existent conversation ID
    const fakeConversationId = new Types.ObjectId().toString();
    const form5a = new FormData();
    form5a.append(
      "file",
      new Blob([validPngBuffer], { type: "image/png" }),
      "pixel.png",
    );
    form5a.append("conversationId", fakeConversationId);

    const res5a = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      body: form5a,
    });

    assert.equal(res5a.status, 404, "Non-existent conversation must return 404");
    const json5a = await res5a.json();
    assert.equal(json5a.success, false);
    assert.equal(json5a.error.code, "CONVERSATION_NOT_FOUND");

    // 5b. Missing conversationId parameter completely
    const form5b = new FormData();
    form5b.append(
      "file",
      new Blob([validPngBuffer], { type: "image/png" }),
      "pixel.png",
    );

    const res5b = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      body: form5b,
    });

    assert.equal(res5b.status, 400, "Missing conversationId must return 400");
    const json5b = await res5b.json();
    assert.equal(json5b.success, false);
    assert.equal(json5b.error.code, "MISSING_CONVERSATION_ID");
    console.log("✓ Missing conversation verified (404 for unknown, 400 for absent parameter)");

    // -------------------------------------------------------------
    // Test 6: Conversation belongs to another user
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing conversation ownership enforcement...");
    // User B attempts to attach to User A's conversation
    const form6 = new FormData();
    form6.append(
      "file",
      new Blob([validPngBuffer], { type: "image/png" }),
      "pixel.png",
    );
    form6.append("conversationId", conversationA._id.toString());

    const res6 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`, // User B!
      },
      body: form6,
    });

    assert.equal(res6.status, 403, "Other user's conversation must return 403 FORBIDDEN");
    const json6 = await res6.json();
    assert.equal(json6.success, false);
    assert.equal(json6.error.code, "FORBIDDEN");
    console.log("✓ Cross-user conversation access rejected with 403 FORBIDDEN");

    // -------------------------------------------------------------
    // Test 7: Cloudinary failure handling
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing Cloudinary upload failure handling...");
    // Temporarily mock upload_stream to return an error
    const originalUploadStream = cloudinaryModule.cloudinary.uploader.upload_stream;
    (cloudinaryModule.cloudinary.uploader as any).upload_stream = (
      _options: any,
      cb: any,
    ) => {
      const stream = new Writable({
        write(_chunk: any, _enc: any, next: any) {
          next();
        },
      });
      stream.on("finish", () => {
        cb(new Error("Cloudinary simulated gateway timeout"), null);
      });
      return stream;
    };

    try {
      const form7 = new FormData();
      form7.append(
        "file",
        new Blob([validPngBuffer], { type: "image/png" }),
        "fail.png",
      );
      form7.append("conversationId", conversationA._id.toString());

      const res7 = await fetch(`${baseUrl}/api/v1/attachments/image`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
        },
        body: form7,
      });

      assert.equal(res7.status, 502, "Cloudinary failure must return 502");
      const json7 = await res7.json();
      assert.equal(json7.success, false);
      assert.equal(json7.error.code, "CLOUDINARY_UPLOAD_FAILED");
    } finally {
      // Restore original method
      cloudinaryModule.cloudinary.uploader.upload_stream = originalUploadStream;
    }
    console.log("✓ Cloudinary failure handled with 502 CLOUDINARY_UPLOAD_FAILED");

    // -------------------------------------------------------------
    // Test 8: MongoDB failure after Cloudinary upload + asset cleanup
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing MongoDB failure after Cloudinary upload + rollback cleanup...");
    let deletedAssetId: string | null = null;
    const originalDestroy = cloudinaryModule.cloudinary.uploader.destroy;
    (cloudinaryModule.cloudinary.uploader as any).destroy = async (
      publicId: string,
      options: any,
    ) => {
      deletedAssetId = publicId;
      return originalDestroy.call(
        cloudinaryModule.cloudinary.uploader,
        publicId,
        options,
      );
    };

    // Temporarily mock Attachment.create to fail
    const originalCreate = Attachment.create;
    (Attachment as any).create = async () => {
      throw new Error("Simulated MongoDB connection drop after upload");
    };

    try {
      await uploadImageAttachment({
        userId: userA._id.toString(),
        conversationId: conversationA._id.toString(),
        file: validPngBuffer,
        originalName: "rollback-test.png",
        mimeType: "image/png",
        size: validPngBuffer.length,
      });
      assert.fail("Should have thrown error on DB failure");
    } catch (err: any) {
      assert.equal(
        err.message,
        "Simulated MongoDB connection drop after upload",
      );
      assert.ok(
        deletedAssetId,
        "Cloudinary cleanup (destroy) MUST be called when MongoDB save fails",
      );
      assert.ok(
        deletedAssetId!.includes(expectedFolderPrefix),
        "Cleaned up asset must match the uploaded publicId",
      );
      console.log(`✓ Orphaned Cloudinary asset cleaned up successfully: ${deletedAssetId}`);
    } finally {
      (Attachment as any).create = originalCreate;
      cloudinaryModule.cloudinary.uploader.destroy = originalDestroy;
    }

    console.log("\n=======================================================");
    console.log(" ALL 8 ATTACHMENT STEP 2 TESTS PASSED SUCCESSFULLY ");
    console.log("=======================================================\n");
  } finally {
    // Teardown created records and Cloudinary assets
    server.close();

    for (const publicId of cloudinaryPublicIdsToClean) {
      try {
        await cloudinaryModule.deleteImageFromCloudinary(publicId);
      } catch (err) {
        // ignore teardown errors
      }
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
  console.error("Attachment upload API test failed:", err);
  process.exit(1);
});
