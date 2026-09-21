import assert from "node:assert";
import { getProviderProductId } from "../src/modules/subscriptions/billing-catalog.service.js";
import { createCheckoutSessionSchema } from "../src/modules/subscriptions/subscription.validation.js";

async function run() {
  console.log("1. Verifying billing catalog resolution...");
  const plusMonthly = getProviderProductId("PLUS", "MONTHLY");
  const plusYearly = getProviderProductId("PLUS", "YEARLY");
  const proMonthly = getProviderProductId("PRO", "MONTHLY");
  const proYearly = getProviderProductId("PRO", "YEARLY");

  assert.ok(plusMonthly, "PLUS monthly should resolve to a provider product ID");
  assert.ok(plusYearly, "PLUS yearly should resolve to a provider product ID");
  assert.ok(proMonthly, "PRO monthly should resolve to a provider product ID");
  assert.ok(proYearly, "PRO yearly should resolve to a provider product ID");
  console.log("   ✓ All paid combinations resolve successfully to provider product IDs");

  console.log("2. Verifying FREE plan rejection...");
  try {
    getProviderProductId("FREE", "MONTHLY");
    assert.fail("FREE should have thrown");
  } catch (err: any) {
    assert.strictEqual(err.code, "FREE_PLAN_NO_PROVIDER_PRODUCT");
    assert.strictEqual(err.statusCode, 400);
    console.log("   ✓ FREE plan correctly rejected with 400 FREE_PLAN_NO_PROVIDER_PRODUCT");
  }

  console.log("3. Verifying invalid plan rejection...");
  try {
    getProviderProductId("ULTRA", "MONTHLY");
    assert.fail("ULTRA should have thrown");
  } catch (err: any) {
    assert.strictEqual(err.code, "INVALID_PLAN_CODE");
    assert.strictEqual(err.statusCode, 400);
    console.log("   ✓ Invalid plan code correctly rejected with 400 INVALID_PLAN_CODE");
  }

  console.log("4. Verifying invalid interval rejection...");
  try {
    getProviderProductId("PLUS", "DAILY");
    assert.fail("DAILY should have thrown");
  } catch (err: any) {
    assert.strictEqual(err.code, "INVALID_BILLING_INTERVAL");
    assert.strictEqual(err.statusCode, 400);
    console.log("   ✓ Invalid interval correctly rejected with 400 INVALID_BILLING_INTERVAL");
  }

  console.log("5. Verifying schema validation...");
  const validParse = createCheckoutSessionSchema.safeParse({
    body: { planCode: "PLUS", interval: "MONTHLY" },
  });
  assert.strictEqual(validParse.success, true, "Valid input should pass schema validation");

  const extraUserId = createCheckoutSessionSchema.safeParse({
    body: { planCode: "PLUS", interval: "MONTHLY", userId: "spoofed" },
  });
  assert.strictEqual(extraUserId.success, false, "Extra userId must be rejected by strict schema");

  const extraProductId = createCheckoutSessionSchema.safeParse({
    body: { planCode: "PLUS", interval: "MONTHLY", providerProductId: "spoofed" },
  });
  assert.strictEqual(extraProductId.success, false, "Extra providerProductId must be rejected by strict schema");

  console.log("   ✓ Strict schema validation rejects untrusted frontend fields");

  console.log("\nALL CHECKOUT API BOUNDARY UNIT TESTS PASSED!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
