import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

interface TestSuite {
  id: string;
  name: string;
  file: string;
}

interface SuiteResult {
  suite: TestSuite;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
}

const TEST_SUITES: TestSuite[] = [
  {
    id: "billing-checkout",
    name: "Billing: Checkout API Boundary",
    file: "billing-checkout.test.ts",
  },
  {
    id: "webhook-billing",
    name: "Billing: Webhook Pipeline & Credit Grants",
    file: "webhook-billing.test.ts",
  },
  {
    id: "auth-registration",
    name: "Auth: Registration UX & Safety",
    file: "auth-registration.test.ts",
  },
  {
    id: "cors",
    name: "F04: CORS Hardening",
    file: "cors.test.ts",
  },
  {
    id: "rate-limit",
    name: "F07: API Rate Limiting",
    file: "rate-limit.test.ts",
  },
  {
    id: "ollama-timeout",
    name: "F05: Ollama Provider Timeout",
    file: "ollama-timeout.test.ts",
  },
  {
    id: "credit-failure",
    name: "F02: Credit Failure Semantics",
    file: "credit-failure.test.ts",
  },
  {
    id: "streaming-chat",
    name: "Chat UX Batch 2: Streaming & Stop Generating",
    file: "streaming-chat.test.ts",
  },
  {
    id: "cross-conversation-context",
    name: "Chat UX Batch 3: Cross-Conversation Context",
    file: "cross-conversation-context.test.ts",
  },
  {
    id: "conversation-summary",
    name: "Chat UX Batch 4: Conversation Summaries & Continuity",
    file: "conversation-summary.test.ts",
  },
  {
    id: "conversation-continuity",
    name: "Chat UX Batch 4b: Cross-Conversation Continuity",
    file: "conversation-continuity.test.ts",
  },
  {
    id: "persistent-memory-integration",
    name: "Phase 6: Final Persistent Memory Integration & Hardening",
    file: "persistent-memory-integration.test.ts",
  },
  {
    id: "ai-orchestrator",
    name: "AI Orchestrator & F14 Canonical Route",
    file: "ai-orchestrator.test.ts",
  },
  {
    id: "token-and-regression",
    name: "Token Engine & F09 Security Regressions",
    file: "token-and-regression.test.ts",
  },
  {
    id: "pagination",
    name: "F06: Pagination for Conversations & Messages",
    file: "pagination.test.ts",
  },
  {
    id: "ai-context",
    name: "F13: AI Context Window Protection",
    file: "ai-context.test.ts",
  },
  {
    id: "memory",
    name: "M1: Memory Foundation",
    file: "memory.test.ts",
  },
  {
    id: "memory-context",
    name: "M3: Memory Retrieval & AI Context Integration",
    file: "memory-ai-context.test.ts",
  },
  {
    id: "memory-extraction",
    name: "M4: Automatic Memory Extraction",
    file: "memory-extraction.test.ts",
  },
  {
    id: "memory-semantic",
    name: "M5: Semantic Memory Intelligence",
    file: "memory-semantic.test.ts",
  },
  {
    id: "memory-wording-relevance",
    name: "M6: Memory Relevance & Assistant Wording",
    file: "memory-wording-relevance.test.ts",
  },
  {
    id: "streaming-regression",
    name: "AI Streaming: Regression & Lifecycle Semantics",
    file: "streaming-regression.test.ts",
  },
  {
    id: "groq-413-streaming",
    name: "AI Streaming: Groq 413 & Lifecycle Semantics",
    file: "groq-413-streaming.test.ts",
  },
  {
    id: "agent-tool-executor",
    name: "Agent Core: Tool Executor",
    file: "agent-tool-executor.test.ts",
  },
  {
    id: "agent-calculator-tool",
    name: "Agent Core: Calculator Tool",
    file: "agent-calculator-tool.test.ts",
  },
  {
    id: "agent-loop",
    name: "Agent Core: Agent Loop",
    file: "agent-loop.test.ts",
  },
  {
    id: "agent-service",
    name: "Agent Core: Agent Service",
    file: "agent-service.test.ts",
  },
  {
    id: "agent-api",
    name: "Agent Core: Agent API",
    file: "agent-api.test.ts",
  },
  {
    id: "agent-e2e",
    name: "Agent Core: End-to-End Verification",
    file: "agent-e2e.test.ts",
  },
  {
    id: "agent-shared-context",
    name: "Agent Core: Shared Context Integration",
    file: "agent-shared-context.test.ts",
  },
  {
    id: "agent-streaming",
    name: "Agent Core: Streaming & Stop Agent",
    file: "agent-streaming.test.ts",
  },
];

const maskMongoUri = (uri: string): string => {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
  }
};

const runSingleSuite = async (
  suite: TestSuite,
  index: number,
  total: number,
  targetEnv: NodeJS.ProcessEnv
): Promise<SuiteResult> => {
  const suitePath = path.join(__dirname, suite.file);
  console.log(`\n${"=".repeat(80)}`);
  console.log(`>>> [${index + 1}/${total}] RUNNING SUITE: ${suite.name}`);
  console.log(`    File: tests/${suite.file}`);
  console.log(`${"=".repeat(80)}\n`);

  const startTime = Date.now();

  return new Promise<SuiteResult>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", suitePath], {
      cwd: backendRoot,
      stdio: "inherit",
      env: targetEnv,
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - startTime;
      console.error(`\nFailed to start child process for ${suite.file}:`, err);
      resolve({
        suite,
        passed: false,
        exitCode: -1,
        durationMs,
      });
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      const passed = code === 0;

      if (passed) {
        console.log(`\n✓ [PASS] ${suite.name} completed in ${(durationMs / 1000).toFixed(2)}s`);
      } else {
        console.error(`\n✗ [FAIL] ${suite.name} failed with exit code ${code} after ${(durationMs / 1000).toFixed(2)}s`);
      }

      resolve({
        suite,
        passed,
        exitCode: code,
        durationMs,
      });
    });
  });
};

const main = async () => {
  console.log("\n" + "=".repeat(80));
  console.log("             NEXAMIND BACKEND AUTOMATED TEST INFRASTRUCTURE (F12)               ");
  console.log("=".repeat(80));

  // 1. Guard against running in production
  if (process.env.NODE_ENV === "production") {
    console.error("\n[CRITICAL ERROR] Refusing to execute automated test suite in PRODUCTION mode.");
    console.error("Automated tests modify, create, and tear down database records.");
    console.error("Please set NODE_ENV=test or NODE_ENV=development and point to an isolated test database.\n");
    process.exit(1);
  }

  // 2. Identify target database
  const activeMongoUri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI;
  if (!activeMongoUri) {
    console.error("\n[CRITICAL ERROR] No MONGODB_URI or MONGODB_TEST_URI found in environment.");
    console.error("Automated tests require a database connection string to execute.\n");
    process.exit(1);
  }

  const isTestOverride = Boolean(process.env.MONGODB_TEST_URI);
  console.log(`Environment:   ${process.env.NODE_ENV || "development"}`);
  console.log(`Target DB:     ${maskMongoUri(activeMongoUri)} ${isTestOverride ? "(from MONGODB_TEST_URI)" : "(from MONGODB_URI)"}`);
  console.log(`Execution:     Sequential child processes (full isolation)`);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "test",
    ...(isTestOverride ? { MONGODB_URI: process.env.MONGODB_TEST_URI } : {}),
  };

  // 3. Filter suites if arguments are provided (e.g. npm test cors)
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  let suitesToRun = TEST_SUITES;

  if (args.length > 0) {
    const filterTerm = args[0]?.toLowerCase() ?? "";
    const filtered = TEST_SUITES.filter(
      (s) => s.id.toLowerCase().includes(filterTerm) || s.file.toLowerCase().includes(filterTerm)
    );
    if (filtered.length > 0) {
      suitesToRun = filtered;
      console.log(`Filter:        '${filterTerm}' matched ${filtered.length} of ${TEST_SUITES.length} suites`);
    } else {
      console.log(`Filter:        '${filterTerm}' did not match any specific suite. Running all ${TEST_SUITES.length} suites.`);
    }
  }

  console.log(`Suites Count:  ${suitesToRun.length}`);
  console.log("-".repeat(80));

  const suiteResults: SuiteResult[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < suitesToRun.length; i++) {
    const suite = suitesToRun[i]!;
    const result = await runSingleSuite(suite, i, suitesToRun.length, childEnv);
    suiteResults.push(result);
  }

  const overallDurationMs = Date.now() - overallStart;

  // 4. Output Summary Table
  console.log("\n" + "=".repeat(80));
  console.log("                          TEST SUITE EXECUTION SUMMARY                          ");
  console.log("=".repeat(80));
  console.log(
    `${"Suite Name".padEnd(42)} ${"File".padEnd(24)} ${"Status".padEnd(8)} ${"Duration".padStart(8)}`
  );
  console.log("-".repeat(80));

  let passedCount = 0;
  for (const r of suiteResults) {
    if (r.passed) passedCount++;
    const statusText = r.passed ? "PASSED" : "FAILED";
    const durationText = `${(r.durationMs / 1000).toFixed(2)}s`;
    console.log(
      `${r.suite.name.padEnd(42)} ${r.suite.file.padEnd(24)} ${statusText.padEnd(8)} ${durationText.padStart(8)}`
    );
  }

  console.log("-".repeat(80));
  const failedCount = suiteResults.length - passedCount;
  console.log(
    `Total: ${suiteResults.length} | Passed: ${passedCount} | Failed: ${failedCount} | Total Duration: ${(overallDurationMs / 1000).toFixed(2)}s`
  );

  if (failedCount === 0) {
    console.log("\n>>> OVERALL RESULT: ALL TEST SUITES PASSED SUCCESSFULLY (Exit Code: 0) <<<\n");
    process.exit(0);
  } else {
    console.error(`\n>>> OVERALL RESULT: ${failedCount} TEST SUITE(S) FAILED (Exit Code: 1) <<<\n`);
    process.exit(1);
  }
};

main().catch((err) => {
  console.error("Unexpected error in test runner:", err);
  process.exit(1);
});
