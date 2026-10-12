import "dotenv/config";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { User } from "../src/modules/users/user.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { CreditTransaction } from "../src/modules/credit-transactions/credit-transaction.model.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import { resolveDedicatedTestDbUri } from "../load-tests/config.ts";
import { AppError } from "../src/errors/app.error.js";

interface TestUserContext {
  userId: string;
  initialCredits: number;
}

const createdUserIds: string[] = [];

async function createIsolatedTestUser(
  prefix: string,
  initialCredits: number
): Promise<TestUserContext> {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 100000);
  const user = await User.create({
    name: `${prefix} Test User`,
    email: `${prefix}-${timestamp}-${randomSuffix}@test.local`,
    passwordHash: "secureTestHash123456789",
    roles: ["USER"],
    status: "ACTIVE",
  });

  const userId = user._id.toString();
  createdUserIds.push(userId);

  await tokenService.initializeBalance(userId, initialCredits);

  return { userId, initialCredits };
}

async function cleanUpTestUsers(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const objectIds = createdUserIds.map((id) => new Types.ObjectId(id));
  try {
    await Promise.all([
      User.deleteMany({ _id: { $in: objectIds } }),
      TokenBalance.deleteMany({ userId: { $in: objectIds } }),
      CreditTransaction.deleteMany({ userId: { $in: objectIds } }),
    ]);
  } catch (err) {
    console.warn("Cleanup warning:", err);
  }
}

async function runCreditConcurrencyAndIntegrityTests(): Promise<void> {
  console.log("\n==========================================================================");
  console.log("=== NEXAMIND CREDIT CONCURRENCY & LEDGER INTEGRITY TEST SUITE ===");
  console.log("==========================================================================");

  const testDbUri = resolveDedicatedTestDbUri();
  console.log(`[Setup] Connecting to isolated test database: ${testDbUri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@")}`);

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(testDbUri);
  }
  console.log("[Setup] Connected to isolated test database.\n");

  try {
    // -------------------------------------------------------------------------
    // TEST 1: OVERDRAFT SAFETY
    // Seed 5 credits and run 20 concurrent deductions of 1 credit.
    // Expect exactly 5 successes, 15 insufficient-credit failures,
    // final balance 0, and exactly 5 successful usage transactions.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1: OVERDRAFT SAFETY] Seeding 5 credits with 20 concurrent deductions...");
    console.log("--------------------------------------------------------------------------");

    const test1User = await createIsolatedTestUser("test1-overdraft", 5);
    const balanceBeforeT1 = await tokenService.getBalance(test1User.userId);
    assert.equal(balanceBeforeT1.balance, 5, "Initial balance must be exactly 5");

    const concurrencyCount = 20;
    const deductionAmount = 1;

    const t1Promises = Array.from({ length: concurrencyCount }).map(async (_, idx) => {
      const refId = `t1_overdraft_ref_${idx + 1}_${Date.now()}`;
      try {
        const result = await tokenService.deductCredits(test1User.userId, deductionAmount, refId);
        return { success: true, balanceAfter: result.balance, error: null };
      } catch (err: unknown) {
        return { success: false, balanceAfter: null, error: err };
      }
    });

    const t1Results = await Promise.all(t1Promises);

    const successfulT1 = t1Results.filter((r) => r.success);
    const failedT1 = t1Results.filter((r) => !r.success);

    console.log(`[Test 1] Concurrency Results: ${successfulT1.length} succeeded, ${failedT1.length} failed`);

    assert.equal(
      successfulT1.length,
      5,
      `Expected exactly 5 successful deductions from 5 initial credits, but got ${successfulT1.length}`
    );
    assert.equal(
      failedT1.length,
      15,
      `Expected exactly 15 rejected deductions, but got ${failedT1.length}`
    );

    // Verify all 15 failures received INSUFFICIENT_CREDITS / HTTP 402
    for (const fail of failedT1) {
      assert.ok(fail.error instanceof AppError, "Failed requests must throw an AppError");
      assert.equal(
        fail.error.code,
        "INSUFFICIENT_CREDITS",
        `Expected error code INSUFFICIENT_CREDITS, got ${fail.error.code}`
      );
      assert.equal(
        fail.error.statusCode,
        402,
        `Expected HTTP status 402, got ${fail.error.statusCode}`
      );
    }

    // Verify final stored balance is strictly 0 (never negative)
    const finalBalanceT1Service = await tokenService.getBalance(test1User.userId);
    assert.equal(finalBalanceT1Service.balance, 0, "Service reported balance must be strictly 0");

    const finalBalanceDocT1 = await TokenBalance.findOne({
      userId: new Types.ObjectId(test1User.userId),
    });
    assert.equal(finalBalanceDocT1?.balance, 0, "Direct DB balance document must be strictly 0");

    // Verify ledger has exactly 5 USAGE transactions
    const usageTransactionsT1 = await CreditTransaction.find({
      userId: new Types.ObjectId(test1User.userId),
      type: "USAGE",
    });
    assert.equal(
      usageTransactionsT1.length,
      5,
      `Expected exactly 5 USAGE transactions in ledger, got ${usageTransactionsT1.length}`
    );

    console.log("✓ Test 1 Passed: Overdraft safety confirmed. Exactly 5 successes, 15 402 failures, final balance 0, 5 ledger USAGE entries.\n");

    // -------------------------------------------------------------------------
    // TEST 2: LEDGER INTEGRITY
    // Run concurrent deductions and refunds.
    // Verify balanceBefore/balanceAfter arithmetic and reconcile the
    // transaction ledger with the final balance, including initial grants.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 2: LEDGER INTEGRITY] Concurrent deductions & refunds with full ledger reconciliation...");
    console.log("--------------------------------------------------------------------------");

    const initialT2Credits = 25;
    const test2User = await createIsolatedTestUser("test2-ledger", initialT2Credits);

    // Initial grant record check
    const initialGrantTx = await CreditTransaction.findOne({
      userId: new Types.ObjectId(test2User.userId),
      type: "PLAN_GRANT",
    });
    assert.ok(initialGrantTx, "Initial PLAN_GRANT transaction must exist");
    assert.equal(initialGrantTx.balanceBefore, 0, "Initial grant balanceBefore must be 0");
    assert.equal(initialGrantTx.balanceAfter, initialT2Credits, "Initial grant balanceAfter must equal initial credits");
    assert.equal(initialGrantTx.amount, initialT2Credits, "Initial grant amount must equal initial credits");

    // Launch concurrent mixed operations:
    // 6 deductions of 2 credits each (Total: -12 credits)
    // 4 refunds of 3 credits each (Total: +12 credits)
    // 4 deductions of 1 credit each (Total: -4 credits)
    // Net expected change: -12 + 12 - 4 = -4 credits
    // Expected final balance: 25 - 4 = 21 credits
    const mixedOps: Array<{ type: "deduct" | "refund"; amount: number; ref: string }> = [
      { type: "deduct", amount: 2, ref: "tx_deduct_2_a" },
      { type: "refund", amount: 3, ref: "tx_refund_3_a" },
      { type: "deduct", amount: 2, ref: "tx_deduct_2_b" },
      { type: "deduct", amount: 1, ref: "tx_deduct_1_a" },
      { type: "refund", amount: 3, ref: "tx_refund_3_b" },
      { type: "deduct", amount: 2, ref: "tx_deduct_2_c" },
      { type: "refund", amount: 3, ref: "tx_refund_3_c" },
      { type: "deduct", amount: 1, ref: "tx_deduct_1_b" },
      { type: "deduct", amount: 2, ref: "tx_deduct_2_d" },
      { type: "refund", amount: 3, ref: "tx_refund_3_d" },
      { type: "deduct", amount: 2, ref: "tx_deduct_2_e" },
      { type: "deduct", amount: 1, ref: "tx_deduct_1_c" },
      { type: "deduct", amount: 2, ref: "tx_deduct_2_f" },
      { type: "deduct", amount: 1, ref: "tx_deduct_1_d" },
    ];

    const mixedPromises = mixedOps.map(async (op, idx) => {
      const fullRef = `${op.ref}_${idx}_${Date.now()}`;
      if (op.type === "deduct") {
        return tokenService.deductCredits(test2User.userId, op.amount, fullRef);
      } else {
        return tokenService.refundCredits(test2User.userId, op.amount, fullRef);
      }
    });

    await Promise.all(mixedPromises);

    // Fetch all transactions for this user
    const allLedgerTxs = await CreditTransaction.find({
      userId: new Types.ObjectId(test2User.userId),
    }).sort({ createdAt: 1 });

    console.log(`[Test 2] Auditing ${allLedgerTxs.length} ledger transactions for arithmetic correctness...`);

    let arithmeticViolations = 0;
    let netLedgerCalculated = 0;

    for (const tx of allLedgerTxs) {
      assert.ok(tx.balanceBefore >= 0, `balanceBefore must be >= 0: found ${tx.balanceBefore}`);
      assert.ok(tx.balanceAfter >= 0, `balanceAfter must be >= 0: found ${tx.balanceAfter}`);
      assert.ok(Number.isInteger(tx.amount), `amount must be integer: found ${tx.amount}`);

      if (tx.type === "USAGE") {
        if (tx.balanceBefore - tx.amount !== tx.balanceAfter) {
          arithmeticViolations++;
        }
        netLedgerCalculated -= tx.amount;
      } else if (tx.type === "REFUND" || tx.type === "PLAN_GRANT") {
        if (tx.balanceBefore + tx.amount !== tx.balanceAfter) {
          arithmeticViolations++;
        }
        netLedgerCalculated += tx.amount;
      }
    }

    assert.equal(
      arithmeticViolations,
      0,
      `Ledger arithmetic violated in ${arithmeticViolations} transaction records`
    );

    // Reconcile final balance against the entire transaction ledger
    const finalBalanceServiceT2 = await tokenService.getBalance(test2User.userId);
    const finalBalanceDocT2 = await TokenBalance.findOne({
      userId: new Types.ObjectId(test2User.userId),
    });

    console.log(`[Test 2] Reconciliation: Stored Balance = ${finalBalanceDocT2?.balance}, Net Ledger Calculation = ${netLedgerCalculated}`);

    assert.equal(
      finalBalanceDocT2?.balance,
      netLedgerCalculated,
      `Stored balance (${finalBalanceDocT2?.balance}) must match sum of all ledger events (${netLedgerCalculated})`
    );
    assert.equal(
      finalBalanceServiceT2.balance,
      finalBalanceDocT2?.balance,
      "Service balance must strictly match DB document balance"
    );

    console.log("✓ Test 2 Passed: Ledger integrity confirmed. Zero arithmetic violations, ledger perfectly reconciles with final balance.\n");

    // -------------------------------------------------------------------------
    // TEST 3: IDEMPOTENCY
    // Submit two concurrent deductions with the same referenceId.
    // Verify credits are deducted at most once.
    // Follow the existing service contract: do not assume duplicate-key
    // errors if existing behavior is to return an idempotent result.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 3: IDEMPOTENCY] Submitting two concurrent deductions with identical referenceId...");
    console.log("--------------------------------------------------------------------------");

    const test3User = await createIsolatedTestUser("test3-idempotency", 10);
    const initialT3Balance = (await tokenService.getBalance(test3User.userId)).balance;
    const sharedReferenceId = `idempotent_order_${Date.now()}_abc`;

    // Fire two simultaneous deductions using the identical referenceId
    const [settledA, settledB] = await Promise.allSettled([
      tokenService.deductCredits(test3User.userId, 2, sharedReferenceId),
      tokenService.deductCredits(test3User.userId, 2, sharedReferenceId),
    ]);

    const successes = [settledA, settledB].filter((s) => s.status === "fulfilled");
    const rejections = [settledA, settledB].filter((s) => s.status === "rejected");

    console.log(`[Test 3] Concurrent Idempotency Outcomes: Fulfilled=${successes.length}, Rejected=${rejections.length}`);

    // Core Invariant: Credits MUST be deducted at most once
    const finalT3BalanceDoc = await TokenBalance.findOne({
      userId: new Types.ObjectId(test3User.userId),
    });
    const finalT3Balance = finalT3BalanceDoc?.balance ?? -1;

    // Check ledger records matching the referenceId
    const matchingT3Txs = await CreditTransaction.find({
      userId: new Types.ObjectId(test3User.userId),
      referenceId: sharedReferenceId,
    });

    console.log(`[Test 3] Matching transactions in ledger: ${matchingT3Txs.length}. Balance after: ${finalT3Balance} (Initial was ${initialT3Balance})`);

    assert.equal(
      matchingT3Txs.length,
      1,
      `Ledger must contain exactly 1 transaction for the referenceId, but found ${matchingT3Txs.length}`
    );

    assert.equal(
      finalT3Balance,
      initialT3Balance - 2,
      `Balance must be decremented by exactly 2 (at most once). Expected ${initialT3Balance - 2}, got ${finalT3Balance}`
    );

    // If existing service contract threw an error on duplicate, verify it is handled or is duplicate-key
    if (rejections.length > 0) {
      const err = (rejections[0] as PromiseRejectedResult).reason;
      console.log(`[Test 3] Rejection detail: ${err?.message || err}`);
      // Duplicate key error from MongoDB has code 11000
      const isDuplicateKey =
        (err as any)?.code === 11000 ||
        (err as any)?.errorLabels?.includes?.("TransientTransactionError") ||
        (err as any)?.message?.includes?.("duplicate");
      assert.ok(isDuplicateKey || err instanceof Error, "Rejection should be an Error or duplicate key code");
    }

    console.log("✓ Test 3 Passed: Idempotency confirmed. Exactly one deduction applied, ledger contains exactly 1 entry.\n");

    // -------------------------------------------------------------------------
    // TEST 4: LEDGER WRITE FAILURE (TRANSACTION ROLLBACK)
    // Simulate a ledger-write failure.
    // Verify the balance and ledger remain consistent.
    // With the current transaction architecture, confirm rollback rather
    // than introducing manual compensation.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 4: LEDGER WRITE FAILURE] Simulating ledger-write failure & verifying native rollback...");
    console.log("--------------------------------------------------------------------------");

    const test4User = await createIsolatedTestUser("test4-rollback", 10);
    const balanceBeforeT4 = (await tokenService.getBalance(test4User.userId)).balance;
    assert.equal(balanceBeforeT4, 10, "Initial balance must be 10");

    const simulatedRef = `simulated_failure_ref_${Date.now()}`;
    const originalSave = CreditTransaction.prototype.save;

    let simulationTriggered = false;

    // Intercept CreditTransaction.prototype.save to simulate a database write failure mid-transaction
    CreditTransaction.prototype.save = async function (this: any, ...args: any[]) {
      simulationTriggered = true;
      throw new Error("SIMULATED_DB_WRITE_FAILURE: I/O disk failure on CreditTransaction collection insert");
    };

    let caughtError: unknown = null;
    try {
      await tokenService.deductCredits(test4User.userId, 4, simulatedRef);
    } catch (err: unknown) {
      caughtError = err;
    } finally {
      // Restore prototype function immediately
      CreditTransaction.prototype.save = originalSave;
    }

    assert.ok(simulationTriggered, "Simulation hook must have been called");
    assert.ok(caughtError, "deductCredits must reject when ledger insert fails");
    console.log(`[Test 4] Caught simulated failure as expected: ${(caughtError as Error).message}`);

    // Verify balance was NOT decremented (native transaction rollback)
    const balanceAfterT4Doc = await TokenBalance.findOne({
      userId: new Types.ObjectId(test4User.userId),
    });
    assert.equal(
      balanceAfterT4Doc?.balance,
      balanceBeforeT4,
      `Balance must remain ${balanceBeforeT4} after transaction rollback, but found ${balanceAfterT4Doc?.balance}`
    );

    const balanceAfterT4Service = await tokenService.getBalance(test4User.userId);
    assert.equal(
      balanceAfterT4Service.balance,
      balanceBeforeT4,
      "Service reported balance must match pre-failure balance"
    );

    // Verify no phantom ledger record exists
    const phantomTx = await CreditTransaction.findOne({
      userId: new Types.ObjectId(test4User.userId),
      referenceId: simulatedRef,
    });
    assert.equal(phantomTx, null, "No phantom transaction record must exist for the aborted deduction");

    console.log("✓ Test 4 Passed: Native MongoDB transaction rollback confirmed. Balance restored, zero orphan ledger records.\n");

    
    // -------------------------------------------------------------------------
    // TEST 5: REFUND IDEMPOTENCY
    // Submitting two concurrent refunds with identical referenceId.
    // Verify credits are refunded at most once.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 5: REFUND IDEMPOTENCY] Submitting two concurrent refunds with same referenceId...");
    console.log("--------------------------------------------------------------------------");

    const test5User = await createIsolatedTestUser("test5-refund-idemp", 10);
    const balanceBeforeT5 = (await tokenService.getBalance(test5User.userId)).balance;
    assert.equal(balanceBeforeT5, 10, "Initial balance must be 10");

    const initialDeductRef = `t5_deduct_op_${Date.now()}`;
    await tokenService.deductCredits(test5User.userId, 2, initialDeductRef);
    const balanceAfterDeductT5 = (await tokenService.getBalance(test5User.userId)).balance;
    assert.equal(balanceAfterDeductT5, 8, "Balance after 2 credit deduction must be 8");

    const refundReferenceId = `refund_${initialDeductRef}`;

    // Concurrently trigger two refunds for the same deduction
    const [settledRefA, settledRefB] = await Promise.allSettled([
      tokenService.refundCredits(test5User.userId, 2, refundReferenceId),
      tokenService.refundCredits(test5User.userId, 2, refundReferenceId),
    ]);

    const refSuccesses = [settledRefA, settledRefB].filter((s) => s.status === "fulfilled");
    console.log(`[Test 5] Concurrent Refund Outcomes: Fulfilled=${refSuccesses.length}`);

    const finalBalanceT5Doc = await TokenBalance.findOne({
      userId: new Types.ObjectId(test5User.userId),
    });
    const finalBalanceT5 = finalBalanceT5Doc?.balance ?? -1;

    const matchingRefundTxs = await CreditTransaction.find({
      userId: new Types.ObjectId(test5User.userId),
      referenceId: refundReferenceId,
      type: "REFUND",
    });

    console.log(`[Test 5] Refund ledger count: ${matchingRefundTxs.length}, Final balance: ${finalBalanceT5}`);

    assert.equal(
      matchingRefundTxs.length,
      1,
      `Ledger must contain exactly 1 REFUND transaction for ${refundReferenceId}, but found ${matchingRefundTxs.length}`
    );
    assert.equal(
      finalBalanceT5,
      10,
      `Balance must be restored to 10 (never double-refunded to 12). Got ${finalBalanceT5}`
    );
    console.log("✓ Test 5 Passed: Refund idempotency confirmed. Exactly 1 refund applied, balance restored to 10.\n");

    // -------------------------------------------------------------------------
    // TEST 6: CHAT REQUEST RETRY BEHAVIOR (STABLE REFERENCE ID)
    // A retry of the same logical Chat operation must use the same referenceId
    // and deduct credits at most once.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 6: CHAT RETRY BEHAVIOR] Simulating Chat retry with identical idempotencyKey...");
    console.log("--------------------------------------------------------------------------");

    const test6User = await createIsolatedTestUser("test6-chat-retry", 10);
    const initialBalanceT6 = (await tokenService.getBalance(test6User.userId)).balance;
    const chatKey = `chat_req_${Date.now()}_unique123`;
    const chatRefId = `chat_conv999_${chatKey}`;

    // First chat deduction
    const firstChatDeduct = await tokenService.deductCredits(test6User.userId, 1, chatRefId);
    assert.equal(firstChatDeduct.balance, initialBalanceT6 - 1, "First chat deduct should decrement balance by 1");

    // Retry of the exact same chat operation (e.g. client network retry)
    const retryChatDeduct = await tokenService.deductCredits(test6User.userId, 1, chatRefId);
    assert.equal(retryChatDeduct.balance, initialBalanceT6 - 1, "Retry chat deduct must return idempotent balance without re-deducting");

    const finalBalanceT6Doc = await TokenBalance.findOne({
      userId: new Types.ObjectId(test6User.userId),
    });
    assert.equal(
      finalBalanceT6Doc?.balance,
      initialBalanceT6 - 1,
      `Balance must only be decremented once (expected ${initialBalanceT6 - 1}, got ${finalBalanceT6Doc?.balance})`
    );

    const chatTxs = await CreditTransaction.find({
      userId: new Types.ObjectId(test6User.userId),
      referenceId: chatRefId,
    });
    assert.equal(chatTxs.length, 1, `Expected exactly 1 USAGE transaction for ${chatRefId}, found ${chatTxs.length}`);
    console.log("✓ Test 6 Passed: Chat retry idempotency confirmed. Exactly 1 deduction, no duplicate charge.\n");

    // -------------------------------------------------------------------------
    // TEST 7: AGENT REQUEST RETRY BEHAVIOR (STABLE REFERENCE ID)
    // A retry of the same logical Agent operation must use the same referenceId
    // and deduct credits at most once.
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 7: AGENT RETRY BEHAVIOR] Simulating Agent retry with identical idempotencyKey...");
    console.log("--------------------------------------------------------------------------");

    const test7User = await createIsolatedTestUser("test7-agent-retry", 10);
    const initialBalanceT7 = (await tokenService.getBalance(test7User.userId)).balance;
    const agentKey = `agent_req_${Date.now()}_step999`;
    const agentRefId = `agent_conv888_${agentKey}`;

    // First agent deduction
    const firstAgentDeduct = await tokenService.deductCredits(test7User.userId, 1, agentRefId);
    assert.equal(firstAgentDeduct.balance, initialBalanceT7 - 1, "First agent deduct should decrement balance by 1");

    // Retry of the exact same agent operation
    const retryAgentDeduct = await tokenService.deductCredits(test7User.userId, 1, agentRefId);
    assert.equal(retryAgentDeduct.balance, initialBalanceT7 - 1, "Retry agent deduct must return idempotent balance without re-deducting");

    const finalBalanceT7Doc = await TokenBalance.findOne({
      userId: new Types.ObjectId(test7User.userId),
    });
    assert.equal(
      finalBalanceT7Doc?.balance,
      initialBalanceT7 - 1,
      `Balance must only be decremented once (expected ${initialBalanceT7 - 1}, got ${finalBalanceT7Doc?.balance})`
    );

    const agentTxs = await CreditTransaction.find({
      userId: new Types.ObjectId(test7User.userId),
      referenceId: agentRefId,
    });
    assert.equal(agentTxs.length, 1, `Expected exactly 1 USAGE transaction for ${agentRefId}, found ${agentTxs.length}`);
    console.log("✓ Test 7 Passed: Agent retry idempotency confirmed. Exactly 1 deduction, no duplicate charge.\n");

    console.log("==========================================================================");
    console.log("=== ALL 7 CREDIT CONCURRENCY & LEDGER INTEGRITY TESTS PASSED (7/7) ===");
    console.log("==========================================================================\n");
  } finally {
    console.log("[Teardown] Cleaning up isolated test users...");
    await cleanUpTestUsers();
    console.log("[Teardown] Disconnecting from test database...");
    await mongoose.disconnect();
    console.log("[Teardown] Teardown complete.");
  }
}

runCreditConcurrencyAndIntegrityTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
