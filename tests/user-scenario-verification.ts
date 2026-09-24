import { isContinuityRequest, extractTopicKeywords, getContinuityContextForUser } from "../src/modules/conversations/conversation-continuity.service.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import assert from "node:assert/strict";

async function testUserScenario() {
  console.log("=== Testing User Specific Scenarios ===");
  
  // Turn 1 assertions
  const q1 = "hey do you remebr last what we are talking about";
  assert.equal(isContinuityRequest(q1), true, "Turn 1 must be continuity request");
  const keywords1 = extractTopicKeywords(q1);
  console.log("Turn 1 keywords:", keywords1);
  assert.equal(keywords1.length, 0, "Turn 1 must have 0 topic keywords (generic continuity)");

  // Another real query from user history
  const qHistory = "hey remeber what we are disscusedd last char";
  assert.equal(isContinuityRequest(qHistory), true, "Typo query must be continuity request");

  // Turn 2 follow up
  const q2 = "hey we are learnign javascript";
  const keywords2 = extractTopicKeywords(q2);
  console.log("Turn 2 keywords:", keywords2);
  assert.deepEqual(keywords2, ["javascript"], "Turn 2 must extract javascript topic keyword");

  await connectDatabase();
  const userId = "6ab36fb6201725754bffbfdc";
  const currentConversationId = "6ab4eb586e623e3561c36e55";

  // Test Turn 1 retrieval
  const ctx1 = await getContinuityContextForUser({
    userId,
    currentConversationId,
    userQuery: q1,
  });
  console.log("\n[Turn 1 Context Found]:", Boolean(ctx1));
  assert.ok(ctx1, "Turn 1 must retrieve continuity context");
  assert.ok(ctx1.includes("Hey i want to know about javascript") || ctx1.includes("JavaScript"), "Turn 1 must retrieve JavaScript conversation");
  console.log("Turn 1 sample:", ctx1.slice(0, 200).replace(/\n/g, " "));

  // Test Turn 2 follow-up retrieval
  const ctx2 = await getContinuityContextForUser({
    userId,
    currentConversationId,
    userQuery: q2,
    recentMessages: [
      { role: "user", content: q1 },
      { role: "assistant", content: "I don't have a record of the previous conversation on hand, so I'm not sure what we were discussing earlier. Let me know what you'd like to pick up on, and I'll be happy to help!" }
    ]
  });
  console.log("\n[Turn 2 Follow-Up Context Found]:", Boolean(ctx2));
  assert.ok(ctx2, "Turn 2 follow-up must retrieve continuity context");
  assert.ok(ctx2.includes("JavaScript"), "Turn 2 must retrieve JavaScript conversation context");
  console.log("Turn 2 sample:", ctx2.slice(0, 200).replace(/\n/g, " "));

  await disconnectDatabase();
  console.log("\n✓ USER SCENARIO TEST PASSED 100%!");
}

testUserScenario().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
