import mongoose from "mongoose";
import { LoadTestHarness } from "../harness.ts";
import * as tokenService from "../../src/modules/tokens/token.service.js";
import { CreditTransaction } from "../../src/modules/credit-transactions/credit-transaction.model.js";
import { TokenBalance } from "../../src/modules/tokens/token.model.js";
import {
  PerformanceCollector,
  computePercentiles,
  printTierSummaryTable,
  type ScenarioTierResult,
} from "../metrics.ts";

export async function runCreditConcurrencyScenario(
  harness: LoadTestHarness
): Promise<ScenarioTierResult[]> {
  const concurrency = harness.config.creditConcurrencyCount;
  console.log(`\n=========================================================================================`);
  console.log(`>>> SCENARIO 4: CREDIT CONCURRENCY & TRANSACTION INTEGRITY`);
  console.log(`    Target: ${concurrency} simultaneous credit deductions against a single dedicated test user`);
  console.log(`=========================================================================================\n`);

  // 1. Create a dedicated test user with exact initial balance matching concurrency
  const session = await harness.createTestUser("credit-audit", concurrency);
  const initialBalanceInfo = await tokenService.getBalance(session.userId);

  console.log(`Created dedicated test user ${session.userId}. Initial balance: ${initialBalanceInfo.balance} credits.`);

  const collector = new PerformanceCollector();
  collector.start();
  const startTime = Date.now();

  // 2. Fire N simultaneous credit deductions concurrently
  const deductionPromises = Array.from({ length: concurrency }).map(async (_, idx) => {
    const reqStart = Date.now();
    try {
      const result = await tokenService.deductCredits(
        session.userId,
        1,
        `loadtest_ref_${idx + 1}`
      );
      return {
        success: true,
        statusCode: 200,
        durationMs: Date.now() - reqStart,
        balanceAfter: result.balance,
      };
    } catch (err: unknown) {
      return {
        success: false,
        statusCode: (err as any)?.statusCode || 500,
        durationMs: Date.now() - reqStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const deductionResults = await Promise.all(deductionPromises);
  const tierDurationSec = Math.max(0.001, (Date.now() - startTime) / 1000);
  const metrics = collector.stop();

  // 3. Process Request Metrics
  const statusCodes: Record<number, number> = {};
  const durations: number[] = [];
  let successfulDeductions = 0;

  for (const dr of deductionResults) {
    statusCodes[dr.statusCode] = (statusCodes[dr.statusCode] || 0) + 1;
    if (dr.success) successfulDeductions++;
    durations.push(dr.durationMs);
  }

  // 4. Audit Database Invariants
  const finalBalanceRecord = await TokenBalance.findOne({
    userId: new mongoose.Types.ObjectId(session.userId),
  });
  const finalBalance = finalBalanceRecord?.balance ?? -1;

  const transactionRecords = await CreditTransaction.find({
    userId: new mongoose.Types.ObjectId(session.userId),
    type: "USAGE",
  }).sort({ createdAt: 1 });

  const expectedFinalBalance = initialBalanceInfo.balance - successfulDeductions;
  const balanceMatch = finalBalance === expectedFinalBalance;
  const transactionCountMatch = transactionRecords.length === successfulDeductions;

  // Invariant check: verify balanceBefore - amount === balanceAfter on every record
  let invariantViolations = 0;
  for (const tx of transactionRecords) {
    if (tx.balanceBefore - tx.amount !== tx.balanceAfter) {
      invariantViolations++;
    }
  }

  // 5. Test Overdraft Protection: Attempt deduction with 0 balance
  let overdraftRejected = false;
  if (finalBalance === 0) {
    try {
      await tokenService.deductCredits(session.userId, 1, "overdraft_test");
    } catch (err: unknown) {
      if ((err as any)?.code === "INSUFFICIENT_CREDITS" || (err as any)?.statusCode === 402) {
        overdraftRejected = true;
      }
    }
  }

  const allIntegrityPassed =
    balanceMatch &&
    transactionCountMatch &&
    invariantViolations === 0 &&
    (finalBalance > 0 || overdraftRejected);

  const integrityDetails = [
    `Initial=${initialBalanceInfo.balance}`,
    `Final=${finalBalance}`,
    `Deductions=${successfulDeductions}/${concurrency}`,
    `TransactionsInLedger=${transactionRecords.length}`,
    `InvariantViolations=${invariantViolations}`,
    `OverdraftProtected=${overdraftRejected ? "YES" : "N/A"}`,
  ].join(" | ");

  const totalRequests = concurrency;
  const failedRequests = totalRequests - successfulDeductions;
  const errorRatePercent = (failedRequests / totalRequests) * 100;
  const throughputReqSec = Math.round((totalRequests / tierDurationSec) * 100) / 100;

  const tierResult: ScenarioTierResult = {
    scenarioName: "Credit Concurrency",
    concurrency,
    totalRequests,
    successfulRequests: successfulDeductions,
    failedRequests,
    errorRatePercent,
    statusCodes,
    totalDurationMs: computePercentiles(durations),
    throughputReqSec,
    eventLoopLag: metrics.eventLoopLag,
    memory: metrics.memory,
    integrityCheck: {
      passed: allIntegrityPassed,
      details: integrityDetails,
    },
  };

  printTierSummaryTable(tierResult);

  // Cleanup test user
  await harness.cleanUpUser(session.userId);

  return [tierResult];
}
