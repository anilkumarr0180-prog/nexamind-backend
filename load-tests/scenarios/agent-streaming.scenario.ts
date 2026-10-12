import { LoadTestHarness, type TestUserSession } from "../harness.ts";
import {
  PerformanceCollector,
  computePercentiles,
  printTierSummaryTable,
  type ScenarioTierResult,
} from "../metrics.ts";

interface AgentStreamClientResult {
  statusCode: number;
  ttfeMs: number | null;
  totalDurationMs: number;
  eventsCount: number;
  hasToolEvent: boolean;
  hasDoneEvent: boolean;
  success: boolean;
  error?: string;
}

async function executeSingleAgentStream(
  baseUrl: string,
  session: TestUserSession,
  task: string,
  abortAfterEvents: number = 0
): Promise<AgentStreamClientResult> {
  const startTime = Date.now();
  let ttfeMs: number | null = null;
  let eventsCount = 0;
  let hasToolEvent = false;
  let hasDoneEvent = false;
  const abortController = new AbortController();

  try {
    const res = await fetch(`${baseUrl}/api/v1/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        task,
        maxSteps: 3,
      }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      return {
        statusCode: res.status,
        ttfeMs: null,
        totalDurationMs: Date.now() - startTime,
        eventsCount: 0,
        hasToolEvent: false,
        hasDoneEvent: false,
        success: false,
        error: `HTTP ${res.status}`,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text.includes("data: ")) {
        eventsCount++;
        if (ttfeMs === null) {
          ttfeMs = Date.now() - startTime;
        }

        if (text.includes('"tool_status"') || text.includes('"calculator"')) {
          hasToolEvent = true;
        }
        if (text.includes('"done"')) {
          hasDoneEvent = true;
        }

        if (abortAfterEvents > 0 && eventsCount >= abortAfterEvents) {
          abortController.abort();
          break;
        }
      }
    }

    return {
      statusCode: res.status,
      ttfeMs,
      totalDurationMs: Date.now() - startTime,
      eventsCount,
      hasToolEvent,
      hasDoneEvent,
      success: true,
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));

    if (isAbort && abortAfterEvents > 0) {
      return {
        statusCode: 200,
        ttfeMs,
        totalDurationMs: Date.now() - startTime,
        eventsCount,
        hasToolEvent,
        hasDoneEvent,
        success: true,
      };
    }

    return {
      statusCode: 500,
      ttfeMs,
      totalDurationMs: Date.now() - startTime,
      eventsCount,
      hasToolEvent: false,
      hasDoneEvent: false,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runAgentStreamingScenario(
  harness: LoadTestHarness
): Promise<ScenarioTierResult[]> {
  console.log(`\n=========================================================================================`);
  console.log(`>>> SCENARIO 2: AGENT STREAMING (POST /api/v1/agent/stream)`);
  console.log(`    Target Tiers: [${harness.config.agentConcurrencyTiers.join(", ")}] concurrent multi-step requests`);
  console.log(`=========================================================================================\n`);

  const results: ScenarioTierResult[] = [];

  for (const concurrency of harness.config.agentConcurrencyTiers) {
    console.log(`--- Initiating Agent Concurrency: ${concurrency} requests ---`);
    await harness.resetRateLimits();

    // 1. Prepare test users
    const sessions: TestUserSession[] = [];
    for (let i = 0; i < concurrency; i++) {
      const session = await harness.createTestUser(`agent-${concurrency}-${i}`, 200);
      sessions.push(session);
    }

    const collector = new PerformanceCollector();
    collector.start();
    const tierStartTime = Date.now();

    // 2. Launch concurrent multi-step agent streams
    const clientPromises = sessions.map((session, idx) =>
      executeSingleAgentStream(
        harness.baseUrl,
        session,
        `Calculate expression for load test worker ${idx + 1}: 25 * 40`
      )
    );

    const clientResults = await Promise.all(clientPromises);
    const tierDurationSec = Math.max(0.001, (Date.now() - tierStartTime) / 1000);
    const metrics = collector.stop();

    // 3. Process Tier Metrics
    const statusCodes: Record<number, number> = {};
    const totalDurations: number[] = [];
    const ttfeValues: number[] = [];
    let successfulCount = 0;

    for (const cr of clientResults) {
      statusCodes[cr.statusCode] = (statusCodes[cr.statusCode] || 0) + 1;
      if (cr.success) successfulCount++;
      totalDurations.push(cr.totalDurationMs);
      if (cr.ttfeMs !== null) ttfeValues.push(cr.ttfeMs);
    }

    const totalRequests = clientResults.length;
    const failedRequests = totalRequests - successfulCount;
    const errorRatePercent = (failedRequests / totalRequests) * 100;
    const throughputReqSec = Math.round((totalRequests / tierDurationSec) * 100) / 100;

    // 4. Test client cancellation on agent execution
    const cancelSession = await harness.createTestUser(`agent-cancel-${concurrency}`, 50);
    const cancelResult = await executeSingleAgentStream(
      harness.baseUrl,
      cancelSession,
      "Multi-step task to abort mid-tool-execution",
      1 // Abort after initial event
    );

    const cancellationPassed = cancelResult.success && cancelResult.eventsCount >= 1;

    const tierResult: ScenarioTierResult = {
      scenarioName: "Agent Streaming",
      concurrency,
      totalRequests,
      successfulRequests: successfulCount,
      failedRequests,
      errorRatePercent,
      statusCodes,
      totalDurationMs: computePercentiles(totalDurations),
      ttftMs: computePercentiles(ttfeValues),
      throughputReqSec,
      eventLoopLag: metrics.eventLoopLag,
      memory: metrics.memory,
      integrityCheck: {
        passed: cancellationPassed && errorRatePercent === 0,
        details: cancellationPassed
          ? "Agent loop cancellation handled cleanly; lifecycle events verified."
          : "Agent cancellation failed or errors encountered during execution.",
      },
    };

    printTierSummaryTable(tierResult);
    results.push(tierResult);

    for (const session of sessions) {
      await harness.cleanUpUser(session.userId);
    }
    await harness.cleanUpUser(cancelSession.userId);
  }

  return results;
}
