import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env, envSchema } from "../src/config/env.js";
import {
  validateCloudinaryConfig,
  getCloudinaryPublicConfig,
} from "../src/config/cloudinary.js";
import {
  validateImageMetadata,
  verifyConversationOwnership,
  createAttachmentMetadata,
  getAttachmentById,
  getConversationAttachments,
} from "../src/modules/attachments/attachment.service.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ATTACHMENT_STATUSES,
  MAX_ATTACHMENT_FILE_SIZE,
} from "../src/modules/attachments/attachment.types.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { User } from "../src/modules/users/user.model.js";
import { AppError } from "../src/errors/app.error.js";
import { Types } from "mongoose";

const runTests = async () => {
  console.log("=== Starting Attachments: Step 1 Backend Foundation & Cloudinary Tests ===");

  // -------------------------------------------------------------
  // Test 1: Cloudinary Configuration Validation
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing Cloudinary configuration validation...");

  // Valid config must pass
  assert.equal(
    validateCloudinaryConfig({
      cloudName: "valid-cloud",
      apiKey: "1234567890",
      apiSecret: "valid-secret-key",
    }),
    true,
    "Valid Cloudinary configuration should return true",
  );

  // Missing cloudName must throw AppError 500 INVALID_CLOUDINARY_CONFIG
  try {
    validateCloudinaryConfig({
      cloudName: "",
      apiKey: "1234567890",
      apiSecret: "valid-secret-key",
    });
    assert.fail("Missing cloudName should have thrown");
  } catch (err: any) {
    assert.ok(err instanceof AppError, "Must be an AppError");
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, "INVALID_CLOUDINARY_CONFIG");
    assert.ok(err.message.includes("cloud name is required"));
  }

  // Missing apiKey must throw AppError 500 INVALID_CLOUDINARY_CONFIG
  try {
    validateCloudinaryConfig({
      cloudName: "valid-cloud",
      apiKey: "   ",
      apiSecret: "valid-secret-key",
    });
    assert.fail("Missing apiKey should have thrown");
  } catch (err: any) {
    assert.ok(err instanceof AppError, "Must be an AppError");
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, "INVALID_CLOUDINARY_CONFIG");
    assert.ok(err.message.includes("API key is required"));
  }

  // Missing apiSecret must throw AppError 500 INVALID_CLOUDINARY_CONFIG
  try {
    validateCloudinaryConfig({
      cloudName: "valid-cloud",
      apiKey: "1234567890",
      apiSecret: "",
    });
    assert.fail("Missing apiSecret should have thrown");
  } catch (err: any) {
    assert.ok(err instanceof AppError, "Must be an AppError");
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, "INVALID_CLOUDINARY_CONFIG");
    assert.ok(err.message.includes("API secret is required"));
  }

  // Safe public config getter must NEVER expose apiSecret
  const publicConfig = getCloudinaryPublicConfig();
  assert.ok(publicConfig.cloudName, "cloudName must be present");
  assert.ok(publicConfig.apiKey, "apiKey must be present");
  assert.equal("apiSecret" in publicConfig, false, "apiSecret MUST NOT be in publicConfig");
  assert.equal("api_secret" in publicConfig, false, "api_secret MUST NOT be in publicConfig");

  // Verify env has loaded Cloudinary variables
  assert.ok(env.CLOUDINARY_CLOUD_NAME, "env.CLOUDINARY_CLOUD_NAME must be loaded");
  assert.ok(env.CLOUDINARY_API_KEY, "env.CLOUDINARY_API_KEY must be loaded");
  assert.ok(env.CLOUDINARY_API_SECRET, "env.CLOUDINARY_API_SECRET must be loaded");

  // Schema validation test: envSchema rejects missing Cloudinary variables
  const invalidEnvCheck = envSchema.safeParse({
    ...process.env,
    CLOUDINARY_CLOUD_NAME: "",
  });
  assert.equal(invalidEnvCheck.success, false, "envSchema must reject empty CLOUDINARY_CLOUD_NAME");

  console.log("✓ Cloudinary configuration validation verified (secrets safely guarded)");

  // -------------------------------------------------------------
  // Test 2: Valid Image Metadata Validation
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing valid image metadata validation...");

  const validJpg = validateImageMetadata({
    originalName: "vacation-photo.jpg",
    mimeType: "image/jpeg",
    size: 1024 * 500, // 500 KB
  });
  assert.equal(validJpg.originalName, "vacation-photo.jpg");
  assert.equal(validJpg.mimeType, "image/jpeg");
  assert.equal(validJpg.size, 512000);

  const validJpeg = validateImageMetadata({
    originalName: "profile.jpeg",
    mimeType: "IMAGE/JPEG", // case-insensitive normalization
    size: 1024 * 1024, // 1 MB
  });
  assert.equal(validJpeg.originalName, "profile.jpeg");
  assert.equal(validJpeg.mimeType, "image/jpeg");

  const validPng = validateImageMetadata({
    originalName: "   diagram.png   ", // whitespace trimming
    mimeType: "image/png",
    size: 2 * 1024 * 1024, // 2 MB
  });
  assert.equal(validPng.originalName, "diagram.png");
  assert.equal(validPng.mimeType, "image/png");

  const validWebp = validateImageMetadata({
    originalName: "hero-image.webp",
    mimeType: "image/webp",
    size: 4 * 1024 * 1024, // 4 MB
  });
  assert.equal(validWebp.originalName, "hero-image.webp");
  assert.equal(validWebp.mimeType, "image/webp");

  console.log("✓ Valid image metadata accepted and normalized (JPG, JPEG, PNG, WEBP)");

  // -------------------------------------------------------------
  // Test 3: Invalid MIME Type & Extension Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing rejection of invalid MIME types...");

  const invalidMimeCases = [
    { name: "document.pdf", mime: "application/pdf" },
    { name: "animation.gif", mime: "image/gif" },
    { name: "vector.svg", mime: "image/svg+xml" },
    { name: "notes.txt", mime: "text/plain" },
    { name: "data.bin", mime: "application/octet-stream" },
  ];

  for (const tc of invalidMimeCases) {
    try {
      validateImageMetadata({
        originalName: tc.name,
        mimeType: tc.mime,
        size: 1024 * 100,
      });
      assert.fail(`Expected MIME type ${tc.mime} to be rejected`);
    } catch (err: any) {
      assert.ok(err instanceof AppError, `Error for ${tc.mime} must be AppError`);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_MIME_TYPE");
    }
  }

  // File extension mismatch (e.g. PDF named as JPG or invalid extension)
  try {
    validateImageMetadata({
      originalName: "malicious.exe",
      mimeType: "image/png",
      size: 1024,
    });
    assert.fail("Non-image extension should be rejected");
  } catch (err: any) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "INVALID_MIME_TYPE");
  }

  console.log("✓ Invalid MIME types strictly rejected with 400 INVALID_MIME_TYPE");

  // -------------------------------------------------------------
  // Test 4: Oversized and Invalid File Size Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing oversized and invalid file sizes...");

  // Exceeds 10MB limit (10MB + 1 byte)
  const oversizedBytes = MAX_ATTACHMENT_FILE_SIZE + 1;
  try {
    validateImageMetadata({
      originalName: "giant-photo.jpg",
      mimeType: "image/jpeg",
      size: oversizedBytes,
    });
    assert.fail("Oversized file should have been rejected");
  } catch (err: any) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "FILE_TOO_LARGE");
    assert.ok(err.message.includes("10MB"));
  }

  // Zero byte file
  try {
    validateImageMetadata({
      originalName: "empty.jpg",
      mimeType: "image/jpeg",
      size: 0,
    });
    assert.fail("Zero-byte file should have been rejected");
  } catch (err: any) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "INVALID_FILE_SIZE");
  }

  // Negative file size
  try {
    validateImageMetadata({
      originalName: "negative.png",
      mimeType: "image/png",
      size: -100,
    });
    assert.fail("Negative size should have been rejected");
  } catch (err: any) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "INVALID_FILE_SIZE");
  }

  console.log("✓ Oversized (>10MB) and non-positive file sizes rejected with 400 errors");

  // -------------------------------------------------------------
  // Test 5: User & Conversation Ownership Verification (Database)
  // -------------------------------------------------------------
  console.log("\n[Test 5] Connecting to database to test user/conversation ownership...");
  await connectDatabase();

  const timestamp = Date.now();
  const userAId = new Types.ObjectId();
  const userBId = new Types.ObjectId();
  let conversationAId: string = "";
  const createdAttachmentIds: string[] = [];

  try {
    // 5a. Unauthenticated user must be rejected with 401 UNAUTHORIZED
    try {
      await verifyConversationOwnership("", new Types.ObjectId().toString());
      assert.fail("Empty userId should have thrown 401 UNAUTHORIZED");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "UNAUTHORIZED");
    }

    // 5b. Missing conversation ID must throw 400 INVALID_INPUT
    try {
      await verifyConversationOwnership(userAId.toString(), "");
      assert.fail("Empty conversationId should have thrown 400");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_INPUT");
    }

    // 5c. Non-existent conversation must throw 404 CONVERSATION_NOT_FOUND
    const fakeConversationId = new Types.ObjectId().toString();
    try {
      await verifyConversationOwnership(userAId.toString(), fakeConversationId);
      assert.fail("Non-existent conversation should have thrown 404");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "CONVERSATION_NOT_FOUND");
    }

    // Create test conversation belonging to User A
    const conversationA = await Conversation.create({
      userId: userAId,
      title: `Attachment Test Conversation ${timestamp}`,
      status: "ACTIVE",
      messageCount: 0,
    });
    conversationAId = conversationA._id.toString();

    // 5d. Conversation belonging to User A accessed by User B must throw 403 FORBIDDEN
    try {
      await verifyConversationOwnership(userBId.toString(), conversationAId);
      assert.fail("User B accessing User A's conversation should throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
      assert.ok(err.message.includes("does not belong"));
    }

    // 5e. Authenticated User A accessing their own conversation must succeed
    const verifiedConvo = await verifyConversationOwnership(
      userAId.toString(),
      conversationAId,
    );
    assert.equal(verifiedConvo._id.toString(), conversationAId);
    console.log("✓ Conversation ownership isolation verified (401, 404, 403 checks pass)");

    // -------------------------------------------------------------
    // Test 6: Create Attachment Record & Metadata Verification
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing attachment creation and metadata persistence...");

    const publicId = `nexamind/conversations/${conversationAId}/sample_${timestamp}`;
    const secureUrl = `https://res.cloudinary.com/nexamind/image/upload/v12345/${publicId}.png`;

    const attachmentRecord = await createAttachmentMetadata({
      userId: userAId.toString(),
      conversationId: conversationAId,
      originalName: "screenshot-test.png",
      mimeType: "image/png",
      size: 1024 * 256,
      cloudinaryPublicId: publicId,
      secureUrl,
      width: 1920,
      height: 1080,
      format: "png",
    });

    createdAttachmentIds.push(attachmentRecord._id.toString());

    // Verify all required metadata fields (Requirement 5)
    assert.ok(attachmentRecord._id, "Attachment must have an _id");
    assert.equal(attachmentRecord.userId.toString(), userAId.toString(), "userId must match");
    assert.equal(attachmentRecord.conversationId.toString(), conversationAId, "conversationId must match");
    assert.equal(attachmentRecord.originalName, "screenshot-test.png", "originalName must match");
    assert.equal(attachmentRecord.mimeType, "image/png", "mimeType must match");
    assert.equal(attachmentRecord.size, 1024 * 256, "size must match");
    assert.equal(attachmentRecord.cloudinaryPublicId, publicId, "cloudinaryPublicId must match");
    assert.equal(attachmentRecord.secureUrl, secureUrl, "secureUrl must match");
    assert.equal(attachmentRecord.status, ATTACHMENT_STATUSES.READY, "status must default to READY");
    assert.ok(attachmentRecord.createdAt instanceof Date, "createdAt must be Date");
    assert.ok(attachmentRecord.updatedAt instanceof Date, "updatedAt must be Date");
    assert.equal(attachmentRecord.width, 1920);
    assert.equal(attachmentRecord.height, 1080);
    assert.equal(attachmentRecord.format, "png");
    console.log("✓ All 10 required metadata fields verified in database record");

    // -------------------------------------------------------------
    // Test 7: Retrieval and Ownership Enforcement on Attachment Read
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing attachment retrieval and ownership isolation...");

    // User A can retrieve their attachment
    const fetchedByOwner = await getAttachmentById(
      attachmentRecord._id.toString(),
      userAId.toString(),
    );
    assert.equal(fetchedByOwner._id.toString(), attachmentRecord._id.toString());

    // User B cannot retrieve User A's attachment -> 403 FORBIDDEN
    try {
      await getAttachmentById(
        attachmentRecord._id.toString(),
        userBId.toString(),
      );
      assert.fail("User B reading User A's attachment should throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    // User A gets conversation attachments list
    const convoAttachments = await getConversationAttachments(
      conversationAId,
      userAId.toString(),
    );
    assert.equal(convoAttachments.length, 1);
    assert.equal(convoAttachments[0]!._id.toString(), attachmentRecord._id.toString());

    // User B cannot list conversation attachments for User A's conversation -> 403 FORBIDDEN
    try {
      await getConversationAttachments(
        conversationAId,
        userBId.toString(),
      );
      assert.fail("User B listing User A's conversation attachments should throw 403 FORBIDDEN");
    } catch (err: any) {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FORBIDDEN");
    }

    console.log("✓ Attachment retrieval and isolation verified successfully");

    console.log("\n=======================================================");
    console.log(" ALL 7 ATTACHMENT FOUNDATION TESTS PASSED SUCCESSFULLY ");
    console.log("=======================================================\n");
  } finally {
    // Cleanup created test records
    if (createdAttachmentIds.length > 0) {
      console.log(`Cleaning up ${createdAttachmentIds.length} test attachment records...`);
      await Attachment.deleteMany({ _id: { $in: createdAttachmentIds } });
    }
    if (conversationAId) {
      console.log("Cleaning up test conversation record...");
      await Conversation.deleteOne({ _id: conversationAId });
    }
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Attachment foundation test failed:", err);
  process.exit(1);
});
