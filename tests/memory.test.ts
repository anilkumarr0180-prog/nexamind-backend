import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";

const runTests = async () => {
  console.log("=== Starting M1: Memory Foundation Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `mem_user_a_${testTimestamp}@example.com`;
  const userBEmail = `mem_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";

  try {
    // Setup Users
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    console.log(`✓ Setup User A (${userAId}) and User B (${userBId})`);

    // -------------------------------------------------------------
    // Test 1: Authenticated memory creation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing authenticated memory creation...");
    const createRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "User prefers dark mode and TypeScript",
      }),
    });

    assert.equal(createRes.status, 201, "Memory creation must return 201 Created");
    const createJson = await createRes.json();
    assert.equal(createJson.success, true);
    assert.equal(createJson.data.type, MEMORY_TYPES.FACT);
    assert.equal(createJson.data.content, "User prefers dark mode and TypeScript");
    assert.equal(createJson.data.status, MEMORY_STATUSES.ACTIVE);
    assert.equal(createJson.data.userId, userAId);
    assert.ok(createJson.data._id, "Created memory must have an _id");
    assert.ok(createJson.data.createdAt, "Created memory must have createdAt timestamp");
    const createdMemoryId = createJson.data._id;
    console.log(`✓ Authenticated memory created successfully (ID: ${createdMemoryId})`);

    // -------------------------------------------------------------
    // Test 2: Unauthenticated request rejected
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing unauthenticated requests rejected...");
    const unauthPostRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "Should not be saved",
      }),
    });
    assert.equal(unauthPostRes.status, 401, "Unauthenticated POST must return 401");
    const unauthPostJson = await unauthPostRes.json();
    assert.equal(unauthPostJson.success, false);
    assert.equal(unauthPostJson.error.code, "UNAUTHORIZED");

    const unauthGetRes = await fetch(`${baseUrl}/api/v1/memories`);
    assert.equal(unauthGetRes.status, 401, "Unauthenticated GET must return 401");
    console.log("✓ Unauthenticated POST and GET requests correctly rejected with 401 UNAUTHORIZED");

    // -------------------------------------------------------------
    // Test 3: Valid memory types accepted
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing all valid memory types accepted...");
    const typesToTest = [
      MEMORY_TYPES.FACT,
      MEMORY_TYPES.PREFERENCE,
      MEMORY_TYPES.GOAL,
      MEMORY_TYPES.INSTRUCTION,
    ];
    for (const memType of typesToTest) {
      const res = await fetch(`${baseUrl}/api/v1/memories`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          type: memType,
          content: `Test content for type ${memType}`,
        }),
      });
      assert.equal(res.status, 201, `Type ${memType} must be accepted with 201`);
      const json = await res.json();
      assert.equal(json.data.type, memType);
    }
    console.log("✓ All 4 memory types (FACT, PREFERENCE, GOAL, INSTRUCTION) successfully accepted");

    // -------------------------------------------------------------
    // Test 4: Invalid type rejected
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing invalid memory type rejected...");
    const invalidTypeRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: "SUPER_SECRET_NOTE",
        content: "Invalid type note",
      }),
    });
    assert.equal(invalidTypeRes.status, 400, "Invalid memory type must return 400");
    const invalidTypeJson = await invalidTypeRes.json();
    assert.equal(invalidTypeJson.success, false);
    assert.equal(invalidTypeJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Invalid memory type rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 5: Empty content rejected
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing empty or whitespace-only content rejected...");
    const emptyRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "",
      }),
    });
    assert.equal(emptyRes.status, 400, "Empty content must return 400");

    const whitespaceRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "   \n\t  ",
      }),
    });
    assert.equal(whitespaceRes.status, 400, "Whitespace-only content must return 400");
    console.log("✓ Empty and whitespace-only content rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 6: Oversized content rejected
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing oversized content rejected...");
    const oversizedContent = "a".repeat(2001);
    const oversizedRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: oversizedContent,
      }),
    });
    assert.equal(oversizedRes.status, 400, "Oversized content (>2000 chars) must return 400");
    const oversizedJson = await oversizedRes.json();
    assert.equal(oversizedJson.success, false);
    assert.equal(oversizedJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Content exceeding 2000 characters rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 7: userId cannot be supplied/overridden by client
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing userId cannot be supplied or overridden by client...");
    const spoofUserRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "Attempting to spoof ownership",
        userId: userBId,
      }),
    });
    assert.equal(spoofUserRes.status, 400, "Supplying userId in body must trigger 400 validation error");

    const spoofStatusRes = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.FACT,
        content: "Attempting to spoof status",
        status: MEMORY_STATUSES.DELETED,
      }),
    });
    assert.equal(spoofStatusRes.status, 400, "Supplying status in body must trigger 400 validation error");
    console.log("✓ Client injection of userId/status strictly rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 8: User can retrieve own memory
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing user can retrieve own memory...");
    const getOwnRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getOwnRes.status, 200, "User must be able to retrieve own memory");
    const getOwnJson = await getOwnRes.json();
    assert.equal(getOwnJson.success, true);
    assert.equal(getOwnJson.data._id, createdMemoryId);
    assert.equal(getOwnJson.data.content, "User prefers dark mode and TypeScript");

    const listOwnRes = await fetch(`${baseUrl}/api/v1/memories`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(listOwnRes.status, 200);
    const listOwnJson = await listOwnRes.json();
    assert.equal(listOwnJson.success, true);
    assert.ok(Array.isArray(listOwnJson.data), "List data must be an array");
    const found = listOwnJson.data.some((m: { _id: string }) => m._id === createdMemoryId);
    assert.ok(found, "User's memory must be in their memory list");
    console.log("✓ User successfully retrieved own memory by ID and in memory list");

    // -------------------------------------------------------------
    // Test 9: User cannot retrieve another user's memory (IDOR/BOLA Protection)
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing cross-user retrieval blocked (IDOR/BOLA)...");
    const crossGetRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(crossGetRes.status, 404, "Cross-user memory GET must return 404 Not Found");
    const crossGetJson = await crossGetRes.json();
    assert.equal(crossGetJson.success, false);
    assert.equal(crossGetJson.error.code, "MEMORY_NOT_FOUND");

    const listUserBRes = await fetch(`${baseUrl}/api/v1/memories`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(listUserBRes.status, 200);
    const listUserBJson = await listUserBRes.json();
    assert.equal(listUserBJson.data.length, 0, "User B memory list must be completely isolated");
    console.log("✓ Cross-user GET returned 404 MEMORY_NOT_FOUND with zero information leak");

    // -------------------------------------------------------------
    // Test 10: User can update own memory
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing user can update own memory...");
    const updateRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        content: "User prefers dark mode, TypeScript, and Vitest",
        type: MEMORY_TYPES.PREFERENCE,
      }),
    });
    assert.equal(updateRes.status, 200, "Update must return 200 OK");
    const updateJson = await updateRes.json();
    assert.equal(updateJson.success, true);
    assert.equal(updateJson.data.content, "User prefers dark mode, TypeScript, and Vitest");
    assert.equal(updateJson.data.type, MEMORY_TYPES.PREFERENCE);
    console.log("✓ User successfully updated own memory content and type");

    // -------------------------------------------------------------
    // Test 11: User cannot update another user's memory
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing cross-user update blocked (IDOR/BOLA)...");
    const crossUpdateRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        content: "Malicious modification by User B",
      }),
    });
    assert.equal(crossUpdateRes.status, 404, "Cross-user memory update must return 404 Not Found");
    const crossUpdateJson = await crossUpdateRes.json();
    assert.equal(crossUpdateJson.error.code, "MEMORY_NOT_FOUND");

    // Verify DB integrity
    const dbMemory = await Memory.findById(createdMemoryId);
    assert.equal(
      dbMemory?.content,
      "User prefers dark mode, TypeScript, and Vitest",
      "Memory content in database must not have been modified by User B",
    );
    console.log("✓ Cross-user PATCH returned 404 and database record was unmodified");

    // -------------------------------------------------------------
    // Test 12: User can soft-delete own memory
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing user can soft-delete own memory...");
    const deleteRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(deleteRes.status, 200, "Soft delete must return 200 OK");
    const deleteJson = await deleteRes.json();
    assert.equal(deleteJson.success, true);
    assert.equal(deleteJson.data.status, MEMORY_STATUSES.DELETED);
    assert.ok(deleteJson.data.deletedAt, "deletedAt timestamp must be populated");

    // Verify document still exists in MongoDB physically
    const rawDeletedDoc = await Memory.findById(createdMemoryId);
    assert.ok(rawDeletedDoc, "Document must still physically exist in MongoDB");
    assert.equal(rawDeletedDoc.status, MEMORY_STATUSES.DELETED);
    assert.ok(rawDeletedDoc.deletedAt instanceof Date);
    console.log("✓ User soft-deleted memory: status set to DELETED, deletedAt populated, doc preserved physically");

    // -------------------------------------------------------------
    // Test 13: User cannot delete another user's memory
    // -------------------------------------------------------------
    console.log("\n[Test 13] Testing cross-user delete blocked (IDOR/BOLA)...");
    // Create a new active memory for User A
    const mem2Res = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        type: MEMORY_TYPES.GOAL,
        content: "User wants to learn AI architectures",
      }),
    });
    const mem2Json = await mem2Res.json();
    const userAMemory2Id = mem2Json.data._id;

    // User B attempts to delete User A's memory
    const crossDeleteRes = await fetch(`${baseUrl}/api/v1/memories/${userAMemory2Id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(crossDeleteRes.status, 404, "Cross-user delete must return 404 Not Found");
    const crossDeleteJson = await crossDeleteRes.json();
    assert.equal(crossDeleteJson.error.code, "MEMORY_NOT_FOUND");

    const mem2Check = await Memory.findById(userAMemory2Id);
    assert.equal(mem2Check?.status, MEMORY_STATUSES.ACTIVE, "Memory must remain ACTIVE");
    console.log("✓ Cross-user DELETE returned 404 and memory remained ACTIVE");

    // -------------------------------------------------------------
    // Test 14: Deleted memory is excluded from normal list
    // -------------------------------------------------------------
    console.log("\n[Test 14] Testing deleted memory is excluded from normal list...");
    const listAfterDeleteRes = await fetch(`${baseUrl}/api/v1/memories`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const listAfterDeleteJson = await listAfterDeleteRes.json();
    const isExcluded = listAfterDeleteJson.data.every(
      (m: { _id: string; status: string }) => m._id !== createdMemoryId && m.status === MEMORY_STATUSES.ACTIVE,
    );
    assert.ok(isExcluded, "Soft-deleted memory must NOT appear in normal listing");
    console.log("✓ Soft-deleted memory successfully excluded from normal memory listing");

    // -------------------------------------------------------------
    // Test 15: Deleted memory cannot be treated as active
    // -------------------------------------------------------------
    console.log("\n[Test 15] Testing deleted memory cannot be read, updated, or re-deleted...");
    // Subsequent GET on soft-deleted memory -> 404
    const getDeletedRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(getDeletedRes.status, 404, "GET on deleted memory must return 404");

    // Subsequent PATCH on soft-deleted memory -> 404
    const patchDeletedRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ content: "Cannot revive or update deleted" }),
    });
    assert.equal(patchDeletedRes.status, 404, "PATCH on deleted memory must return 404");

    // Subsequent DELETE on soft-deleted memory -> 404
    const deleteAgainRes = await fetch(`${baseUrl}/api/v1/memories/${createdMemoryId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(deleteAgainRes.status, 404, "Subsequent DELETE on deleted memory must return 404");
    console.log("✓ Deleted memory cannot be treated as active (GET, PATCH, DELETE all returned 404 MEMORY_NOT_FOUND)");

    // -------------------------------------------------------------
    // Test 16: Malformed memory ID rejected
    // -------------------------------------------------------------
    console.log("\n[Test 16] Testing malformed memory ID rejected with 400 VALIDATION_ERROR...");
    const badIdGet = await fetch(`${baseUrl}/api/v1/memories/not-an-objectid-123`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(badIdGet.status, 400, "Malformed ObjectId in GET must return 400");
    const badIdGetJson = await badIdGet.json();
    assert.equal(badIdGetJson.error.code, "VALIDATION_ERROR");

    const badIdPatch = await fetch(`${baseUrl}/api/v1/memories/123-malformed`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ content: "Update payload" }),
    });
    assert.equal(badIdPatch.status, 400, "Malformed ObjectId in PATCH must return 400");

    const badIdDelete = await fetch(`${baseUrl}/api/v1/memories/5555_bad_id`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(badIdDelete.status, 400, "Malformed ObjectId in DELETE must return 400");
    console.log("✓ Malformed memory IDs strictly rejected across GET, PATCH, and DELETE with 400 VALIDATION_ERROR");

    console.log("\n==================================================");
    console.log(" ALL 16 M1 MEMORY TESTS PASSED SUCCESSFULLY!       ");
    console.log("==================================================");
  } finally {
    // Teardown test data
    try {
      const users = await User.find({
        email: { $in: [userAEmail, userBEmail] },
      });
      const userIds = users.map((u) => u._id);

      if (userIds.length > 0) {
        await Memory.deleteMany({ userId: { $in: userIds } });
        await TokenBalance.deleteMany({ userId: { $in: userIds } });
        await User.deleteMany({ _id: { $in: userIds } });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Memory Test Suite Failed:", err);
  process.exit(1);
});
