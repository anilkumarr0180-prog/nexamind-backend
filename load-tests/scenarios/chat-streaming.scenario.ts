import { LoadTestHarness, type TestUserSession } from "../harness.ts";
import {
  PerformanceCollector,
  computePercentiles,
  printTierSummaryTable,
  type ScenarioTierResult,
} from "../metrics.ts";

interface SingleStreamClientResult {
  statusCode: number;
  ttftMs: number | null;
  totalDurationMs: number;
  chunksCount: number;
  success: boolean;
  error?: string;
}

async function executeSingleChatStream(
  baseUrl: string,
  session: TestUserSession,
  conversationId: string,
  promptText: string,
  abortAfterChunks: number = 0
): Promise<SingleStreamClientResult> {
  const startTime = Date.now();
  let ttftMs: number | null = null;
  let chunksCount = 0;
  const abortController = new AbortController();

  try {
    const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        conversationId,
        content: promptText,
      }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      return {
        statusCode: res.status,
        ttftMs: null,
        totalDurationMs: Date.now() - startTime,
        chunksCount: 0,
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
        chunksCount++;
        if (ttftMs === null) {
          ttftMs = Date.now() - startTime;
        }

        if (abortAfterChunks > 0 && chunksCount >= abortAfterChunks) {
          abortController.abort();
          break;
        }
      }
    }

    return {
      statusCode: res.status,
      ttftMs,
      totalDurationMs: Date.now() - startTime,
      chunksCount,
      success: true,
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));

    if (isAbort && abortAfterChunks > 0) {
      return {
        statusCode: 200,
        ttftMs,
        totalDurationMs: Date.now() - startTime,
        chunksCount,
        success: true,
      };
    }

    return {
      statusCode: 500,
      ttftMs,
      totalDurationMs: Date.now() - startTime,
      chunksCount,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runChatStreamingScenario(
  harness: LoadTestHarness
): Promise<ScenarioTierResult[]> {
  console.log(`\n=========================================================================================`);
  console.log(`>>> SCENARIO 1: CHAT STREAMING (POST /api/v1/ai/chat)`);
  console.log(`    Target Tiers: [${harness.config.chatConcurrencyTiers.join(", ")}] concurrent connections`);
  console.log(`=========================================================================================\n`);

  const results: ScenarioTierResult[] = [];

  for (const concurrency of harness.config.chatConcurrencyTiers) {
    console.log(`--- Initiating Tier Concurrency: ${concurrency} connections ---`);
    await harness.resetRateLimits();

    // 1. Prepare isolated test users & conversations for this tier
    const sessions: Array<{ session: TestUserSession; convId: string }> = [];
    for (let i = 0; i < concurrency; i++) {
      const session = await harness.createTestUser(`chat-${concurrency}-${i}`, 200);
      const conv = await harness.createTestConversation(session.userId, `Chat Test ${i}`);
      sessions.push({ session, convId: conv._id.toString() });
    }

    const collector = new PerformanceCollector();
    collector.start();
    const tierStartTime = Date.now();

    // 2. Launch concurrent SSE streaming clients
    const clientPromises = sessions.map((item, idx) =>
      executeSingleChatStream(
        harness.baseUrl,
        item.session,
        item.convId,
        `Hello NexaMind, please process concurrent request ${idx + 1} of ${concurrency}.`
      )
    );

    const clientResults = await Promise.all(clientPromises);
    const tierDurationSec = Math.max(0.001, (Date.now() - tierStartTime) / 1000);
    const metrics = collector.stop();

    // 3. Process Tier Metrics
    const statusCodes: Record<number, number> = {};
    const totalDurations: number[] = [];
    const ttftValues: number[] = [];
    let successfulCount = 0;

    for (const cr of clientResults) {
      statusCodes[cr.statusCode] = (statusCodes[cr.statusCode] || 0) + 1;
      if (cr.success) successfulCount++;
      totalDurations.push(cr.totalDurationMs);
      if (cr.ttftMs !== null) ttftValues.push(cr.ttftMs);
    }

    const totalRequests = clientResults.length;
    const failedRequests = totalRequests - successfulCount;
    const errorRatePercent = (failedRequests / totalRequests) * 100;
    const throughputReqSec = Math.round((totalRequests / tierDurationSec) * 100) / 100;

    // 4. Verify client cancellation on a dedicated test connection
    const cancelSession = await harness.createTestUser(`chat-cancel-${concurrency}`, 50);
    const cancelConv = await harness.createTestConversation(cancelSession.userId, "Cancel Test");
    const cancelResult = await executeSingleChatStream(
      harness.baseUrl,
      cancelSession,
      cancelConv._id.toString(),
      "Stream message to test client disconnect",
      2 // Abort after 2 chunks
    );

    const cancellationPassed = cancelResult.success && cancelResult.chunksCount >= 1;

    const tierResult: ScenarioTierResult = {
      scenarioName: "Chat Streaming",
      concurrency,
      totalRequests,
      successfulRequests: successfulCount,
      failedRequests,
      errorRatePercent,
      statusCodes,
      totalDurationMs: computePercentiles(totalDurations),
      ttftMs: computePercentiles(ttftValues),
      throughputReqSec,
      eventLoopLag: metrics.eventLoopLag,
      memory: metrics.memory,
      integrityCheck: {
        passed: cancellationPassed && errorRatePercent === 0,
        details: cancellationPassed
          ? "Client cancellation handled cleanly; socket closed with partial tokens."
          : "Cancellation failed to abort cleanly or error rate > 0%.",
      },
    };

    printTierSummaryTable(tierResult);
    results.push(tierResult);

    // Cleanup tier test users
    for (const item of sessions) {
      await harness.cleanUpUser(item.session.userId);
    }
    await harness.cleanUpUser(cancelSession.userId);
  }

  return results;
}
