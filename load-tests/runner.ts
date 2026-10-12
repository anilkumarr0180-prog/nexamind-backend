import { parseLoadTestCliArgs, maskMongoUri } from "./config.ts";
import { LoadTestHarness } from "./harness.ts";
import { type ScenarioTierResult } from "./metrics.ts";
import { runChatStreamingScenario } from "./scenarios/chat-streaming.scenario.ts";
import { runAgentStreamingScenario } from "./scenarios/agent-streaming.scenario.ts";
import { runVoiceTranscriptionScenario } from "./scenarios/voice-transcription.scenario.ts";
import { runCreditConcurrencyScenario } from "./scenarios/credit-concurrency.scenario.ts";

async function main(): Promise<void> {
  console.log("\n" + "=".repeat(95));
  console.log("            NEXAMIND PERFORMANCE & PRODUCTION RELIABILITY LOAD TEST SUITE              ");
  console.log("=".repeat(95));

  let config;
  try {
    config = parseLoadTestCliArgs();
  } catch (err: unknown) {
    console.error(`\n[INITIALIZATION ERROR] ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log(`Environment:      ${process.env.NODE_ENV || "development"}`);
  console.log(`Target Database:  ${maskMongoUri(config.testDbUri)} (Isolated Dedicated Test DB)`);
  console.log(`Provider Mode:    ${config.realProviders ? "LIVE PROVIDERS (Low-Volume Integration)" : "MOCK PROVIDERS (Zero-Cost / High-Throughput)"}`);
  console.log(`Scenario:         ${config.scenario.toUpperCase()}`);
  console.log(`Baseline Mode:    ${config.baseline ? "YES (Minimal Smoke Run)" : "NO (Full Ramp Tiers)"}`);
  console.log("-".repeat(95));

  const harness = new LoadTestHarness(config);
  const allResults: ScenarioTierResult[] = [];
  const suiteStartTime = Date.now();

  try {
    console.log("Setting up load test harness and ephemeral server...");
    await harness.setup();
    console.log(`Harness ready. Server bound to ${harness.baseUrl}\n`);

    if (config.scenario === "all" || config.scenario === "chat") {
      const chatResults = await runChatStreamingScenario(harness);
      allResults.push(...chatResults);
    }

    if (config.scenario === "all" || config.scenario === "agent") {
      const agentResults = await runAgentStreamingScenario(harness);
      allResults.push(...agentResults);
    }

    if (config.scenario === "all" || config.scenario === "voice") {
      const voiceResults = await runVoiceTranscriptionScenario(harness);
      allResults.push(...voiceResults);
    }

    if (config.scenario === "all" || config.scenario === "credit") {
      const creditResults = await runCreditConcurrencyScenario(harness);
      allResults.push(...creditResults);
    }
  } catch (error: unknown) {
    console.error("\n[LOAD TEST EXECUTION FAILURE]:", error);
    process.exitCode = 1;
  } finally {
    console.log("\nTearing down load test harness and database connections...");
    await harness.teardown();
    console.log("Teardown completed.");
  }

  const totalSuiteDurationSec = ((Date.now() - suiteStartTime) / 1000).toFixed(2);

  // Print Consolidated Master Table
  console.log("\n" + "=".repeat(110));
  console.log("                                 CONSOLIDATED LOAD TEST SUMMARY REPORT                         ");
  console.log("=".repeat(110));
  console.log(
    `${"Scenario".padEnd(22)} ${"Concur".padStart(6)} ${"Reqs".padStart(6)} ${"Err%".padStart(6)} ${"Req/s".padStart(7)} ${"TTFT p50".padStart(9)} ${"p50(ms)".padStart(8)} ${"p95(ms)".padStart(8)} ${"Peak RSS".padStart(9)} ${"EL Lag".padStart(8)} ${"Status".padStart(8)}`
  );
  console.log("-".repeat(110));

  let failedTiers = 0;
  for (const r of allResults) {
    const passed = r.integrityCheck.passed && r.errorRatePercent === 0;
    if (!passed) failedTiers++;
    const statusText = passed ? "PASS" : "FAIL";
    const ttftText = r.ttftMs && r.ttftMs.count > 0 ? `${r.ttftMs.p50}ms` : "N/A";
    const elLagText = `${r.eventLoopLag.p95Ms}ms`;

    console.log(
      `${r.scenarioName.padEnd(22)} ${String(r.concurrency).padStart(6)} ${String(r.totalRequests).padStart(6)} ${(r.errorRatePercent.toFixed(1) + "%").padStart(6)} ${r.throughputReqSec.toFixed(1).padStart(7)} ${ttftText.padStart(9)} ${String(r.totalDurationMs.p50).padStart(8)} ${String(r.totalDurationMs.p95).padStart(8)} ${(r.memory.peak.rssMB.toFixed(0) + "MB").padStart(9)} ${elLagText.padStart(8)} ${statusText.padStart(8)}`
    );
  }

  console.log("-".repeat(110));
  console.log(
    `Total Tiers: ${allResults.length} | Passed: ${allResults.length - failedTiers} | Failed: ${failedTiers} | Suite Duration: ${totalSuiteDurationSec}s`
  );

  if (failedTiers > 0) {
    console.error(`\n>>> RESULT: ${failedTiers} LOAD TEST TIER(S) FAILED INTEGRITY CHECKS OR EXPERIENCED ERRORS <<<\n`);
    process.exit(1);
  } else {
    console.log(`\n>>> RESULT: ALL LOAD TEST TIERS COMPLETED SUCCESSFULLY (Exit Code: 0) <<<\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error running load test suite:", err);
  process.exit(1);
});
