import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";

const runTests = async () => {
  console.log("=== Starting F06: Pagination for Conversations and Messages Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `pag_user_a_${testTimestamp}@example.com`;
  const userBEmail = `pag_user_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let testConvId = "";
  let deletedConvId = "";

  try {
    // -------------------------------------------------------------
    // Setup Users
    // -------------------------------------------------------------
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    console.log(`✓ Setup User A (${userAId}) and User B (${userBId})`);

    // -------------------------------------------------------------
    // Setup: Seed 25 Conversations for User A
    // -------------------------------------------------------------
    console.log("\nSeeding 25 conversations for User A...");
    const createdConvIds: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const conv = await Conversation.create({
        userId: userAId,
        title: `Conversation ${String(i).padStart(2, "0")}`,
        updatedAt: new Date(Date.now() - (26 - i) * 1000), // Distinct updatedAt timestamps
      });
      createdConvIds.push(conv._id.toString());
    }
    testConvId = createdConvIds[0]!;
    console.log(`✓ Seeded 25 conversations for User A`);

    // -------------------------------------------------------------
    // Test 1: Default Pagination for Conversations
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing default pagination for conversations...");
    const defaultRes = await fetch(`${baseUrl}/api/v1/conversations`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(defaultRes.status, 200, "Default listing must return 200 OK");
    const defaultJson = await defaultRes.json();
    assert.equal(defaultJson.success, true);
    assert.ok(Array.isArray(defaultJson.data), "data must be an array");
    assert.equal(defaultJson.data.length, 20, "Default page size must be 20");
    assert.deepEqual(defaultJson.pagination, {
      page: 1,
      limit: 20,
      total: 25,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    }, "Default pagination metadata must match 20 items on page 1 of 2");
    console.log("✓ Default pagination returned 20 items with accurate page 1 metadata");

    // -------------------------------------------------------------
    // Test 2: Custom Page and Limit for Conversations
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing custom page and limit (page=2, limit=10)...");
    const p2Res = await fetch(`${baseUrl}/api/v1/conversations?page=2&limit=10`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(p2Res.status, 200);
    const p2Json = await p2Res.json();
    assert.equal(p2Json.data.length, 10, "Page 2 with limit 10 must return 10 items");
    assert.deepEqual(p2Json.pagination, {
      page: 2,
      limit: 10,
      total: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    console.log("✓ Custom page=2&limit=10 returned 10 items with correct hasPreviousPage & hasNextPage");

    // -------------------------------------------------------------
    // Test 3: Maximum Limit Enforcement (max 100)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing maximum limit enforcement...");
    const maxLimitRes = await fetch(`${baseUrl}/api/v1/conversations?limit=100`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(maxLimitRes.status, 200, "Limit 100 must be accepted");
    const maxLimitJson = await maxLimitRes.json();
    assert.equal(maxLimitJson.data.length, 25, "Limit 100 returns all 25 conversations");
    assert.equal(maxLimitJson.pagination.limit, 100);

    const exceedLimitRes = await fetch(`${baseUrl}/api/v1/conversations?limit=101`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(exceedLimitRes.status, 400, "Limit 101 must be rejected with 400");
    const exceedLimitJson = await exceedLimitRes.json();
    assert.equal(exceedLimitJson.error.code, "VALIDATION_ERROR");
    console.log("✓ Limit 100 accepted; limit 101 correctly rejected with 400 VALIDATION_ERROR");

    // -------------------------------------------------------------
    // Test 4: Invalid Page Values Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing invalid page values rejection...");
    const invalidPages = ["0", "-1", "abc", "1.5", ""];
    for (const invalidPage of invalidPages) {
      const res = await fetch(`${baseUrl}/api/v1/conversations?page=${invalidPage}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 400, `Page '${invalidPage}' must return 400`);
      const json = await res.json();
      assert.equal(json.error.code, "VALIDATION_ERROR");
    }
    console.log("✓ Invalid page values (0, negative, non-numeric, decimal) all rejected with 400");

    // -------------------------------------------------------------
    // Test 5: Invalid Limit Values Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing invalid limit values rejection...");
    const invalidLimits = ["0", "-5", "xyz", "1000", ""];
    for (const invalidLimit of invalidLimits) {
      const res = await fetch(`${baseUrl}/api/v1/conversations?limit=${invalidLimit}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 400, `Limit '${invalidLimit}' must return 400`);
      const json = await res.json();
      assert.equal(json.error.code, "VALIDATION_ERROR");
    }
    console.log("✓ Invalid limit values (0, negative, non-numeric, >100) all rejected with 400");

    // -------------------------------------------------------------
    // Test 6: Correct Page Boundaries & No Duplicate / Missing Items
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing page boundaries across all pages...");
    const page1Res = await fetch(`${baseUrl}/api/v1/conversations?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const page1Json = await page1Res.json();
    assert.equal(page1Json.data.length, 10);
    assert.equal(page1Json.pagination.hasNextPage, true);
    assert.equal(page1Json.pagination.hasPreviousPage, false);

    const page2Res = await fetch(`${baseUrl}/api/v1/conversations?page=2&limit=10`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const page2Json = await page2Res.json();
    assert.equal(page2Json.data.length, 10);
    assert.equal(page2Json.pagination.hasNextPage, true);
    assert.equal(page2Json.pagination.hasPreviousPage, true);

    const page3Res = await fetch(`${baseUrl}/api/v1/conversations?page=3&limit=10`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const page3Json = await page3Res.json();
    assert.equal(page3Json.data.length, 5, "Last page should have remainder 5 items");
    assert.equal(page3Json.pagination.hasNextPage, false);
    assert.equal(page3Json.pagination.hasPreviousPage, true);

    const allIds = [
      ...page1Json.data.map((c: any) => c._id),
      ...page2Json.data.map((c: any) => c._id),
      ...page3Json.data.map((c: any) => c._id),
    ];
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, 25, "All 25 items across pages must be distinct (no duplication)");
    console.log("✓ Page boundaries verified: exactly 10, 10, and 5 distinct items with accurate boundary flags");

    // -------------------------------------------------------------
    // Test 7: Empty Page Behavior
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing empty page behavior when page exceeds totalPages...");
    const emptyPageRes = await fetch(`${baseUrl}/api/v1/conversations?page=10&limit=10`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(emptyPageRes.status, 200, "Empty page must return 200 OK");
    const emptyPageJson = await emptyPageRes.json();
    assert.equal(emptyPageJson.data.length, 0, "Empty page should return empty array");
    assert.deepEqual(emptyPageJson.pagination, {
      page: 10,
      limit: 10,
      total: 25,
      totalPages: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    console.log("✓ Out-of-bounds page=10 returned 200 with data=[] and correct total=25");

    // -------------------------------------------------------------
    // Test 8: Conversation Ownership Protection
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing conversation ownership protection...");
    const userBRes = await fetch(`${baseUrl}/api/v1/conversations`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    assert.equal(userBRes.status, 200);
    const userBJson = await userBRes.json();
    assert.equal(userBJson.data.length, 0, "User B must NOT see User A's conversations");
    assert.equal(userBJson.pagination.total, 0);
    console.log("✓ User B received 0 conversations (User A conversations completely isolated)");

    // -------------------------------------------------------------
    // Test 9: Stable Ordering (updatedAt descending, _id descending)
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing stable conversation sorting (updatedAt desc)...");
    const sortRes = await fetch(`${baseUrl}/api/v1/conversations?limit=25`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const sortJson = await sortRes.json();
    for (let i = 0; i < sortJson.data.length - 1; i++) {
      const currTime = new Date(sortJson.data[i].updatedAt).getTime();
      const nextTime = new Date(sortJson.data[i + 1].updatedAt).getTime();
      assert.ok(currTime >= nextTime, `Item ${i} (${currTime}) must be >= item ${i+1} (${nextTime})`);
    }
    console.log("✓ Conversations verified strictly ordered by updatedAt descending");

    // -------------------------------------------------------------
    // Test 10: Soft-Deleted Conversations Excluded
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing soft-deleted conversations remain excluded...");
    deletedConvId = createdConvIds[createdConvIds.length - 1]!;
    await conversationService.deleteConversation(deletedConvId, userAId);

    const afterDeleteRes = await fetch(`${baseUrl}/api/v1/conversations`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const afterDeleteJson = await afterDeleteRes.json();
    assert.equal(afterDeleteJson.pagination.total, 24, "Total count must decrement to 24 after soft-delete");
    const foundDeleted = afterDeleteJson.data.find((c: any) => c._id === deletedConvId);
    assert.equal(foundDeleted, undefined, "Soft-deleted conversation must NOT be in paginated results");
    console.log("✓ Soft-deleted conversation excluded from paginated results and total count");

    // -------------------------------------------------------------
    // Test 11: Message Pagination (Default, Custom, Boundaries)
    // -------------------------------------------------------------
    console.log("\n[Test 11] Seeding 15 messages and testing message pagination...");
    const activeConvId = createdConvIds[0]!;
    for (let i = 1; i <= 15; i++) {
      await Message.create({
        conversationId: activeConvId,
        userId: userAId,
        role: i % 2 === 1 ? MESSAGE_ROLES.USER : MESSAGE_ROLES.ASSISTANT,
        content: `Message ${String(i).padStart(2, "0")}`,
        status: MESSAGE_STATUSES.COMPLETED,
        createdAt: new Date(Date.now() - (16 - i) * 1000), // Chronological timestamps
      });
    }

    // Default message pagination (limit=20)
    const msgDefRes = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(msgDefRes.status, 200);
    const msgDefJson = await msgDefRes.json();
    assert.equal(msgDefJson.data.length, 15, "Default limit 20 returns all 15 messages");
    assert.deepEqual(msgDefJson.pagination, {
      page: 1,
      limit: 20,
      total: 15,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    console.log("✓ Default message pagination returned all 15 messages with totalPages=1");

    // Message custom pagination: page 1 of 5
    const msgP1Res = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?page=1&limit=5`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const msgP1Json = await msgP1Res.json();
    assert.equal(msgP1Json.data.length, 5);
    assert.equal(msgP1Json.pagination.hasNextPage, true);
    assert.equal(msgP1Json.pagination.hasPreviousPage, false);

    // Message custom pagination: page 2 of 5
    const msgP2Res = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?page=2&limit=5`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const msgP2Json = await msgP2Res.json();
    assert.equal(msgP2Json.data.length, 5);
    assert.equal(msgP2Json.pagination.hasNextPage, true);
    assert.equal(msgP2Json.pagination.hasPreviousPage, true);

    // Message custom pagination: page 3 of 5
    const msgP3Res = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?page=3&limit=5`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const msgP3Json = await msgP3Res.json();
    assert.equal(msgP3Json.data.length, 5);
    assert.equal(msgP3Json.pagination.hasNextPage, false);
    assert.equal(msgP3Json.pagination.hasPreviousPage, true);

    // Message custom pagination: page 4 (empty)
    const msgP4Res = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?page=4&limit=5`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const msgP4Json = await msgP4Res.json();
    assert.equal(msgP4Json.data.length, 0);
    assert.equal(msgP4Json.pagination.hasNextPage, false);
    assert.equal(msgP4Json.pagination.hasPreviousPage, true);
    console.log("✓ Message pagination boundaries verified: 5, 5, 5, and 0 items across pages");

    // -------------------------------------------------------------
    // Test 12: Stable Message Ordering (createdAt ascending)
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing stable message chronological ordering (createdAt asc)...");
    const msgSortRes = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?limit=15`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    const msgSortJson = await msgSortRes.json();
    for (let i = 0; i < msgSortJson.data.length - 1; i++) {
      const currTime = new Date(msgSortJson.data[i].createdAt).getTime();
      const nextTime = new Date(msgSortJson.data[i + 1].createdAt).getTime();
      assert.ok(currTime <= nextTime, `Message ${i} (${currTime}) must be <= message ${i+1} (${nextTime})`);
    }
    console.log("✓ Messages verified strictly ordered chronologically by createdAt ascending");

    // -------------------------------------------------------------
    // Test 13: Message Pagination Parameter Validation
    // -------------------------------------------------------------
    console.log("\n[Test 13] Testing message pagination validation errors...");
    const badMsgParams = ["page=0", "page=-1", "page=xyz", "limit=0", "limit=-1", "limit=101", "unexpected=1"];
    for (const badParam of badMsgParams) {
      const res = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages?${badParam}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 400, `Message query '${badParam}' must return 400`);
      const json = await res.json();
      assert.equal(json.error.code, "VALIDATION_ERROR");
    }
    console.log("✓ Message endpoint strictly rejected all invalid query parameters with 400");

    // -------------------------------------------------------------
    // Test 14: Message Ownership Protection
    // -------------------------------------------------------------
    console.log("\n[Test 14] Testing message ownership protection...");
    const crossMsgRes = await fetch(`${baseUrl}/api/v1/conversations/${activeConvId}/messages`, {
      headers: { Authorization: `Bearer ${userBToken}` }, // User B querying User A's conversation
    });
    assert.equal(crossMsgRes.status, 404, "User B querying User A's conversation messages must return 404");
    const crossMsgJson = await crossMsgRes.json();
    assert.equal(crossMsgJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ User B cross-user access to messages rejected with 404 CONVERSATION_NOT_FOUND");

    // -------------------------------------------------------------
    // Test 15: Soft-deleted Conversation Messages Access Protection
    // -------------------------------------------------------------
    console.log("\n[Test 15] Testing access to messages of soft-deleted conversation...");
    const deletedMsgRes = await fetch(`${baseUrl}/api/v1/conversations/${deletedConvId}/messages`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    assert.equal(deletedMsgRes.status, 404, "Messages of soft-deleted conversation must return 404");
    const deletedMsgJson = await deletedMsgRes.json();
    assert.equal(deletedMsgJson.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Messages of soft-deleted conversation rejected with 404 CONVERSATION_NOT_FOUND");

    console.log("\n==================================================");
    console.log(" ALL F06 PAGINATION TESTS PASSED SUCCESSFULLY (15/15) ");
    console.log("==================================================");
  } finally {
    // Teardown test records
    try {
      if (userAId || userBId) {
        const uids = [userAId, userBId].filter(Boolean);
        await TokenBalance.deleteMany({ userId: { $in: uids } });
        await Message.deleteMany({ userId: { $in: uids } });
        await Conversation.deleteMany({ userId: { $in: uids } });
        await User.deleteMany({ _id: { $in: uids } });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Pagination Test Suite Failed:", err);
  process.exit(1);
});
