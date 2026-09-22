import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { verifyPolarWebhookPayload } from "../src/modules/subscriptions/webhook.controller.js";
import { env } from "../src/config/env.js";

async function runTests() {
  console.log("=== Testing Dual-Scheme Polar Webhook Verification ===");
  const secret = env.POLAR_WEBHOOK_SECRET;
  console.log("Using webhook secret:", secret.slice(0, 10) + "..." + secret.slice(-4));

  const payload = {
    type: "subscription.active",
    timestamp: new Date().toISOString(),
    data: {
      id: "sub_test_123",
      status: "active",
      product_id: env.POLAR_PRODUCT_PLUS_MONTHLY,
      recurring_interval: "month",
      customer: {
        id: "cust_123",
        external_id: "6ab21fbc66f1e94cfdcd24f3"
      }
    }
  };

  const bodyStr = JSON.stringify(payload);
  const bodyBuf = Buffer.from(bodyStr);
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000).toString();

  // Test 1: Standard Webhooks Signing (Current Polar Server Scheme - 32-byte key)
  console.log("\n[Test 1] Testing Standard Webhooks Scheme (32-byte key)...");
  const whStandard = new Webhook(secret);
  const sigStandard = whStandard.sign("evt_test_standard", now, bodyStr);
  const headersStandard = {
    "webhook-id": "evt_test_standard",
    "webhook-timestamp": timestamp,
    "webhook-signature": sigStandard
  };

  const res1 = verifyPolarWebhookPayload(bodyBuf, headersStandard, secret);
  if (res1.type === "subscription.active") {
    console.log("✓ Test 1 Passed: Successfully verified via Standard Webhooks scheme!");
  } else {
    throw new Error(`Test 1 Failed: Unexpected result ${JSON.stringify(res1)}`);
  }

  // Test 2: Polar Legacy SDK Signing (50-byte literal secret)
  console.log("\n[Test 2] Testing Legacy Polar SDK Scheme (literal key bytes)...");
  const base64Secret = Buffer.from(secret, "utf-8").toString("base64");
  const whLegacy = new Webhook(base64Secret);
  const sigLegacy = whLegacy.sign("evt_test_legacy", now, bodyStr);
  const headersLegacy = {
    "webhook-id": "evt_test_legacy",
    "webhook-timestamp": timestamp,
    "webhook-signature": sigLegacy
  };

  const res2 = verifyPolarWebhookPayload(bodyBuf, headersLegacy, secret);
  if (res2.type === "subscription.active") {
    console.log("✓ Test 2 Passed: Successfully verified via Legacy SDK scheme!");
  } else {
    throw new Error(`Test 2 Failed: Unexpected result ${JSON.stringify(res2)}`);
  }

  // Test 3: Bad / Tampered Signature (Security Boundary)
  console.log("\n[Test 3] Testing Bad / Tampered Signature...");
  const headersBad = {
    "webhook-id": "evt_test_bad",
    "webhook-timestamp": timestamp,
    "webhook-signature": "v1,badsignaturestring1234567890="
  };

  let rejected = false;
  try {
    verifyPolarWebhookPayload(bodyBuf, headersBad, secret);
  } catch (err: any) {
    if (err instanceof WebhookVerificationError || err.message === "No matching signature found") {
      rejected = true;
      console.log("✓ Test 3 Passed: Bad signature securely rejected with WebhookVerificationError!");
    } else {
      throw err;
    }
  }

  if (!rejected) {
    throw new Error("Test 3 Failed: Bad signature was not rejected!");
  }

  console.log("\n========================================================");
  console.log(" ALL DUAL-SCHEME POLAR WEBHOOK TESTS PASSED (100%) ");
  console.log("========================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
