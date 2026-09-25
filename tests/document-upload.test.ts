import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";
import * as cloudinaryModule from "../src/config/cloudinary.js";
import { MAX_DOCUMENT_FILE_SIZE } from "../src/modules/attachments/attachment.types.js";

const runTests = async () => {
  console.log("=== Starting Document Upload: Step 8 Automated Tests ===");

  await connectDatabase();

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
      email: "doc_user_a_" + timestamp + "@example.com",
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
      email: "doc_user_b_" + timestamp + "@example.com",
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
      title: "Doc Conversation A " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationA._id.toString());

    const conversationB = await Conversation.create({
      userId: userB._id,
      title: "Doc Conversation B " + timestamp,
      status: "ACTIVE",
      messageCount: 0,
    });
    createdConversationIds.push(conversationB._id.toString());

    // Test 1: Valid TXT document upload
    console.log("\n[Test 1] Testing valid TXT document upload...");
    const txtContent = "Project NexaMind Status Report:\nAll systems operational.\nText document upload working.";
    const txtBuffer = Buffer.from(txtContent, "utf-8");
    const form1 = new FormData();
    form1.append("file", new Blob([txtBuffer], { type: "text/plain" }), "report.txt");
    form1.append("conversationId", conversationA._id.toString());
    const res1 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form1,
    });
    assert.equal(res1.status, 201, "Valid TXT upload should return 201 Created");
    const json1 = (await res1.json()) as any;
    assert.equal(json1.success, true);
    assert.equal(json1.data.type, "DOCUMENT");
    assert.equal(json1.data.originalName, "report.txt");
    assert.equal(json1.data.mimeType, "text/plain");
    assert.equal(json1.data.size, txtBuffer.length);
    assert.equal(json1.data.status, "READY");
    assert.equal(json1.data.extractedTextLength, txtContent.length);
    assert.ok(json1.data.secureUrl.startsWith("https://res.cloudinary.com/"));
    createdAttachmentIds.push(json1.data.attachmentId);
    const dbDoc1 = await Attachment.findById(json1.data.attachmentId);
    assert.ok(dbDoc1);
    assert.equal(dbDoc1.type, "DOCUMENT");
    assert.equal(dbDoc1.extractedText, txtContent);
    assert.equal(dbDoc1.extractedTextLength, txtContent.length);
    assert.equal(dbDoc1.format, "txt");
    cloudinaryPublicIdsToClean.push(dbDoc1.cloudinaryPublicId);
    console.log("✓ Valid TXT document upload and text extraction verified");

    // Test 2: Valid MD document upload
    console.log("\n[Test 2] Testing valid MD document upload...");
    const mdContent = "# NexaMind Documentation\n\n## Architecture\n- AgentLoop\n- Attachments\n- Tools";
    const mdBuffer = Buffer.from(mdContent, "utf-8");
    const form2 = new FormData();
    form2.append("file", new Blob([mdBuffer], { type: "text/markdown" }), "guide.md");
    form2.append("conversationId", conversationA._id.toString());
    const res2 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form2,
    });
    assert.equal(res2.status, 201, "Valid MD upload should return 201 Created");
    const json2 = (await res2.json()) as any;
    assert.equal(json2.success, true);
    assert.equal(json2.data.type, "DOCUMENT");
    assert.equal(json2.data.originalName, "guide.md");
    assert.equal(json2.data.extractedTextLength, mdContent.length);
    createdAttachmentIds.push(json2.data.attachmentId);
    const dbDoc2 = await Attachment.findById(json2.data.attachmentId);
    assert.ok(dbDoc2);
    assert.equal(dbDoc2.type, "DOCUMENT");
    assert.equal(dbDoc2.extractedText, mdContent);
    assert.equal(dbDoc2.format, "md");
    cloudinaryPublicIdsToClean.push(dbDoc2.cloudinaryPublicId);
    console.log("✓ Valid MD document upload verified without interpretation or execution");

    // Test 3: Valid JSON document upload
    console.log("\n[Test 3] Testing valid JSON document upload...");
    const jsonObject = { project: "NexaMind", version: "1.0.0", features: ["chat", "agent", "attachments"] };
    const jsonContent = JSON.stringify(jsonObject, null, 2);
    const jsonBuffer = Buffer.from(jsonContent, "utf-8");
    const form3 = new FormData();
    form3.append("file", new Blob([jsonBuffer], { type: "application/json" }), "config.json");
    form3.append("conversationId", conversationA._id.toString());
    const res3 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form3,
    });
    assert.equal(res3.status, 201, "Valid JSON upload should return 201 Created");
    const json3 = (await res3.json()) as any;
    assert.equal(json3.success, true);
    assert.equal(json3.data.type, "DOCUMENT");
    assert.equal(json3.data.originalName, "config.json");
    createdAttachmentIds.push(json3.data.attachmentId);
    const dbDoc3 = await Attachment.findById(json3.data.attachmentId);
    assert.ok(dbDoc3);
    assert.equal(dbDoc3.type, "DOCUMENT");
    assert.equal(dbDoc3.extractedText, jsonContent);
    assert.equal(dbDoc3.format, "json");
    cloudinaryPublicIdsToClean.push(dbDoc3.cloudinaryPublicId);
    console.log("✓ Valid JSON document upload and parsing verified");

    // Test 4: Valid CSV document upload
    console.log("\n[Test 4] Testing valid CSV document upload...");
    const csvContent = "id,name,role,department\n1,Alice,Engineer,AI\n2,Bob,Product,Design\n3,Charlie,Security,Infra";
    const csvBuffer = Buffer.from(csvContent, "utf-8");
    const form4 = new FormData();
    form4.append("file", new Blob([csvBuffer], { type: "text/csv" }), "team.csv");
    form4.append("conversationId", conversationA._id.toString());
    const res4 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form4,
    });
    assert.equal(res4.status, 201, "Valid CSV upload should return 201 Created");
    const json4 = (await res4.json()) as any;
    assert.equal(json4.success, true);
    assert.equal(json4.data.type, "DOCUMENT");
    assert.equal(json4.data.originalName, "team.csv");
    createdAttachmentIds.push(json4.data.attachmentId);
    const dbDoc4 = await Attachment.findById(json4.data.attachmentId);
    assert.ok(dbDoc4);
    assert.equal(dbDoc4.type, "DOCUMENT");
    assert.equal(dbDoc4.extractedText, csvContent);
    assert.equal(dbDoc4.format, "csv");
    cloudinaryPublicIdsToClean.push(dbDoc4.cloudinaryPublicId);
    console.log("✓ Valid CSV document upload verified without interpretation or execution");

    // Test 5: Invalid JSON document failure
    console.log("\n[Test 5] Testing invalid JSON document rejection...");
    const invalidJsonContent = "{\n  \"app\": \"NexaMind\",\n  \"broken\": }";
    const invalidJsonBuffer = Buffer.from(invalidJsonContent, "utf-8");
    const form5 = new FormData();
    form5.append("file", new Blob([invalidJsonBuffer], { type: "application/json" }), "broken.json");
    form5.append("conversationId", conversationA._id.toString());
    const res5 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form5,
    });
    assert.equal(res5.status, 400, "Invalid JSON should be rejected with 400 Bad Request");
    const json5 = (await res5.json()) as any;
    assert.equal(json5.success, false);
    assert.equal(json5.error.code, "INVALID_JSON");
    console.log("✓ Invalid JSON document safely rejected with 400 INVALID_JSON");

    // Test 6: Unsupported file type rejection (.zip, .png)
    console.log("\n[Test 6] Testing unsupported file type rejection (.zip, .png)...");
    const zipForm = new FormData();
    zipForm.append("file", new Blob([Buffer.from("PK mock zip")], { type: "application/zip" }), "archive.zip");
    zipForm.append("conversationId", conversationA._id.toString());
    const zipRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: zipForm,
    });
    assert.equal(zipRes.status, 400, "ZIP upload must be rejected with 400");
    const zipJson = (await zipRes.json()) as any;
    assert.equal(zipJson.success, false);
    assert.equal(zipJson.error.code, "INVALID_MIME_TYPE");

    const imgForm = new FormData();
    imgForm.append("file", new Blob([Buffer.from("fake-png-data")], { type: "image/png" }), "photo.png");
    imgForm.append("conversationId", conversationA._id.toString());
    const imgRes = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: imgForm,
    });
    assert.equal(imgRes.status, 400, "Image on document endpoint must be rejected with 400");
    const imgJson = (await imgRes.json()) as any;
    assert.equal(imgJson.success, false);
    assert.equal(imgJson.error.code, "INVALID_MIME_TYPE");
    console.log("✓ Unsupported file types (.zip, .png) rejected with 400 INVALID_MIME_TYPE");

    // Test 7: Oversized file rejection (>2MB)
    console.log("\n[Test 7] Testing oversized file rejection (>2MB)...");
    const oversizedSize = MAX_DOCUMENT_FILE_SIZE + 1024;
    const oversizedBuffer = Buffer.alloc(oversizedSize, "A");
    const form7 = new FormData();
    form7.append("file", new Blob([oversizedBuffer], { type: "text/plain" }), "huge.txt");
    form7.append("conversationId", conversationA._id.toString());
    const res7 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form7,
    });
    assert.equal(res7.status, 400, "Oversized file should be rejected with 400");
    const json7 = (await res7.json()) as any;
    assert.equal(json7.success, false);
    assert.equal(json7.error.code, "FILE_TOO_LARGE");
    console.log("✓ Oversized file (>2MB) safely rejected with 400 FILE_TOO_LARGE");

    // Test 8: Unauthorized conversation ownership rejection
    console.log("\n[Test 8] Testing unauthorized conversation ownership...");
    const form8 = new FormData();
    form8.append("file", new Blob([Buffer.from("secret")], { type: "text/plain" }), "cross.txt");
    form8.append("conversationId", conversationA._id.toString());
    const res8 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenB },
      body: form8,
    });
    assert.equal(res8.status, 403, "Uploading to another user conversation must return 403 Forbidden");
    const json8 = (await res8.json()) as any;
    assert.equal(json8.success, false);
    assert.equal(json8.error.code, "FORBIDDEN");
    console.log("✓ Unauthorized conversation access rejected with 403 FORBIDDEN");

    // Test 9: Successful metadata persistence verification
    console.log("\n[Test 9] Testing successful metadata persistence in MongoDB...");
    const metaText = "Persistent metadata verification payload";
    const metaBuffer = Buffer.from(metaText, "utf-8");
    const form9 = new FormData();
    form9.append("file", new Blob([metaBuffer], { type: "text/plain" }), "persistent.txt");
    form9.append("conversationId", conversationA._id.toString());
    const res9 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form9,
    });
    assert.equal(res9.status, 201);
    const json9 = (await res9.json()) as any;
    createdAttachmentIds.push(json9.data.attachmentId);
    const persistedDoc = await Attachment.findById(json9.data.attachmentId);
    assert.ok(persistedDoc, "Document must exist in MongoDB");
    assert.equal(persistedDoc.userId.toString(), userA._id.toString());
    assert.equal(persistedDoc.conversationId.toString(), conversationA._id.toString());
    assert.equal(persistedDoc.type, "DOCUMENT");
    assert.equal(persistedDoc.originalName, "persistent.txt");
    assert.equal(persistedDoc.mimeType, "text/plain");
    assert.equal(persistedDoc.size, metaBuffer.length);
    assert.equal(persistedDoc.status, "READY");
    assert.equal(persistedDoc.format, "txt");
    assert.equal(persistedDoc.extractedText, metaText);
    assert.equal(persistedDoc.extractedTextLength, metaText.length);
    assert.ok(persistedDoc.cloudinaryPublicId.includes("documents"));
    assert.ok(persistedDoc.createdAt instanceof Date);
    cloudinaryPublicIdsToClean.push(persistedDoc.cloudinaryPublicId);
    console.log("✓ MongoDB document metadata completely and accurately verified");

    // Test 10: Text extraction failure (binary/null-byte content)
    console.log("\n[Test 10] Testing text extraction failure with binary/null-byte content...");
    const binaryCorruptBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
    const form10 = new FormData();
    form10.append("file", new Blob([binaryCorruptBuffer], { type: "text/plain" }), "corrupt.txt");
    form10.append("conversationId", conversationA._id.toString());
    const res10 = await fetch(baseUrl + "/api/v1/attachments/document", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
      body: form10,
    });
    assert.equal(res10.status, 400, "Binary/null byte text extraction failure must return 400");
    const json10 = (await res10.json()) as any;
    assert.equal(json10.success, false);
    assert.equal(json10.error.code, "TEXT_EXTRACTION_FAILED");
    console.log("✓ Text extraction failure on binary content safely handled with 400 TEXT_EXTRACTION_FAILED");

    console.log("\n=======================================================");
    console.log(" ALL 10 STEP 8 DOCUMENT UPLOAD TESTS PASSED SUCCESSFULLY ");
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
  console.error("Document upload test failed:", err);
  process.exit(1);
});