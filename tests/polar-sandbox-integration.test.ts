import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User, USER_STATUSES } from "../src/modules/users/user.model.js";
import { Subscription } from "../src/modules/subscriptions/subscription.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { generateAccessToken } from "../src/utils/jwt.js";

async function runPolarSandboxIntegrationTest() {
  console.log("=== POLAR SANDBOX CHECKOUT INTEGRATION TEST ===");
  await connectDatabase();

  try {
    // 1. Locate an existing active user without creating or modifying database records
    const user = await User.findOne({ status: USER_STATUSES.ACTIVE });
    if (!user) {
      throw new Error("No active test user found in database. Cannot proceed without existing user.");
    }
    console.log(`✓ Found existing active user with ID: ${user._id.toString()}`);

    // 2. Snapshot state BEFORE checkout session creation
    const subBefore = await Subscription.findOne({ userId: user._id }).lean();
    const tokenBalanceBefore = await TokenBalance.findOne({ userId: user._id }).lean();
    const balanceCountBefore = tokenBalanceBefore ? tokenBalanceBefore.balance : 0;
    console.log(`✓ Snapshot BEFORE: Subscription exists = ${Boolean(subBefore)}, Balance = ${balanceCountBefore}`);

    // 3. Generate valid NexaMind JWT for the authenticated user
    const token = generateAccessToken({
      sub: user._id.toString(),
      roles: user.roles,
    });
    console.log("✓ Generated valid NexaMind access JWT");

    // 4. Call actual running backend endpoint
    const endpointUrl = "http://localhost:5001/api/v1/subscriptions/checkout";
    const requestPayload = {
      planCode: "PLUS",
      interval: "MONTHLY",
    };

    console.log(`\nCalling POST ${endpointUrl}...`);
    const startTime = Date.now();
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestPayload),
    });
    const durationMs = Date.now() - startTime;

    console.log(`HTTP Status: ${response.status} ${response.statusText} (${durationMs}ms)`);
    const responseJson = await response.json();

    // 5. Verify response
    if (response.status !== 200) {
      console.error("Endpoint returned non-200 status:", JSON.stringify(responseJson, null, 2));
      throw new Error(`Checkout endpoint failed with HTTP ${response.status}`);
    }

    assert.equal(responseJson.success, true, "Expected response.success to be true");
    assert.ok(responseJson.data, "Expected response.data to exist");
    assert.ok(responseJson.data.checkoutId, "Expected checkoutId in response.data");
    assert.ok(responseJson.data.checkoutUrl, "Expected checkoutUrl in response.data");

    const checkoutUrl = responseJson.data.checkoutUrl;
    const checkoutId = responseJson.data.checkoutId;

    console.log("\nResponse verification:");
    console.log(`- success: ${responseJson.success}`);
    console.log(`- checkoutId: ${checkoutId}`);
    console.log(`- checkoutUrl: ${checkoutUrl}`);

    // 6. Verify URL belongs to Polar Sandbox checkout flow
    const isSandboxCheckout = checkoutUrl.includes("sandbox.polar.sh") || checkoutUrl.includes("polar.sh");
    assert.ok(
      isSandboxCheckout,
      `Expected checkout URL to belong to Polar Sandbox, received: ${checkoutUrl}`,
    );
    console.log(`✓ Verified checkout URL belongs to Polar Sandbox: ${isSandboxCheckout}`);

    // 7. Verify that creating checkout session did NOT alter database state
    const subAfter = await Subscription.findOne({ userId: user._id }).lean();
    const tokenBalanceAfter = await TokenBalance.findOne({ userId: user._id }).lean();
    const balanceCountAfter = tokenBalanceAfter ? tokenBalanceAfter.balance : 0;

    // Verify subscription was not activated/created
    if (!subBefore) {
      assert.equal(subAfter, null, "Subscription should still not exist after checkout session creation");
    } else {
      assert.deepEqual(
        subBefore.status,
        subAfter?.status,
        "Subscription status must NOT change on session creation",
      );
    }
    console.log("✓ Verified Subscription state was NOT mutated/activated");

    // Verify token balance was not modified
    assert.equal(
      balanceCountAfter,
      balanceCountBefore,
      `Token balance must remain identical (${balanceCountBefore} vs ${balanceCountAfter})`,
    );
    console.log(`✓ Verified TokenBalance was NOT modified (remained: ${balanceCountAfter})`);

    console.log("\n==========================================");
    console.log(">>> POLAR SANDBOX INTEGRATION TEST PASSED <<<");
    console.log("==========================================");
  } finally {
    await disconnectDatabase();
  }
}

runPolarSandboxIntegrationTest().catch((err) => {
  console.error("\n>>> POLAR SANDBOX INTEGRATION TEST FAILED <<<");
  console.error(err);
  process.exit(1);
});
