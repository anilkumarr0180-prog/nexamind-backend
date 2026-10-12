import { LoadTestHarness, type TestUserSession } from "../harness.ts";
import { generateTestWavBuffer } from "../audio-generator.ts";
import {
  PerformanceCollector,
  computePercentiles,
  printTierSummaryTable,
  type ScenarioTierResult,
} from "../metrics.ts";

interface VoiceUploadClientResult {
  statusCode: number;
  durationMs: number;
  success: boolean;
  transcriptLength: number;
  error?: string;
}

async function executeSingleVoiceUpload(
  baseUrl: string,
  session: TestUserSession,
  audioBuffer: Buffer,
  filename: string = "loadtest.wav"
): Promise<VoiceUploadClientResult> {
  const startTime = Date.now();

  try {
    const formData = new FormData();
    const file = new File([new Uint8Array(audioBuffer)], filename, {
      type: "audio/wav",
    });
    formData.append("file", file);

    const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
      body: formData,
    });

    const data = (await res.json()) as any;
    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      return {
        statusCode: res.status,
        durationMs,
        success: false,
        transcriptLength: 0,
        error: data?.error?.message || `HTTP ${res.status}`,
      };
    }

    const text = data?.data?.text || "";
    return {
      statusCode: res.status,
      durationMs,
      success: true,
      transcriptLength: text.length,
    };
  } catch (err: unknown) {
    return {
      statusCode: 500,
      durationMs: Date.now() - startTime,
      success: false,
      transcriptLength: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runVoiceTranscriptionScenario(
  harness: LoadTestHarness
): Promise<ScenarioTierResult[]> {
  const audioSizeBytes = Math.round(harness.config.voiceAudioSizeMB * 1024 * 1024);
  console.log(`\n=========================================================================================`);
  console.log(`>>> SCENARIO 3: VOICE TRANSCRIPTION (POST /api/v1/voice/transcribe)`);
  console.log(`    Target Tiers: [${harness.config.voiceConcurrencyTiers.join(", ")}] concurrent uploads`);
  console.log(`    Audio Payload: ${(audioSizeBytes / (1024 * 1024)).toFixed(1)} MB synthetic valid PCM WAV`);
  console.log(`=========================================================================================\n`);

  console.log("Generating synthetic test WAV buffer in memory...");
  const audioBuffer = generateTestWavBuffer(audioSizeBytes);
  console.log(`Synthetic audio buffer ready (${(audioBuffer.length / (1024 * 1024)).toFixed(2)} MB).`);

  const results: ScenarioTierResult[] = [];

  for (const concurrency of harness.config.voiceConcurrencyTiers) {
    console.log(`--- Initiating Voice Concurrency: ${concurrency} uploads (${concurrency * harness.config.voiceAudioSizeMB} MB aggregate) ---`);
    await harness.resetRateLimits();

    // 1. Prepare test users
    const sessions: TestUserSession[] = [];
    for (let i = 0; i < concurrency; i++) {
      const session = await harness.createTestUser(`voice-${concurrency}-${i}`, 100);
      sessions.push(session);
    }

    const collector = new PerformanceCollector();
    collector.start();
    const tierStartTime = Date.now();

    // 2. Launch concurrent multipart audio uploads
    const clientPromises = sessions.map((session, idx) =>
      executeSingleVoiceUpload(
        harness.baseUrl,
        session,
        audioBuffer,
        `loadtest-${idx + 1}.wav`
      )
    );

    const clientResults = await Promise.all(clientPromises);
    const tierDurationSec = Math.max(0.001, (Date.now() - tierStartTime) / 1000);
    const metrics = collector.stop();

    // 3. Process Tier Metrics
    const statusCodes: Record<number, number> = {};
    const durations: number[] = [];
    let successfulCount = 0;

    for (const cr of clientResults) {
      statusCodes[cr.statusCode] = (statusCodes[cr.statusCode] || 0) + 1;
      if (cr.success) successfulCount++;
      durations.push(cr.durationMs);
    }

    const totalRequests = clientResults.length;
    const failedRequests = totalRequests - successfulCount;
    const errorRatePercent = (failedRequests / totalRequests) * 100;
    const throughputReqSec = Math.round((totalRequests / tierDurationSec) * 100) / 100;

    const rssDeltaMB = Math.round((metrics.memory.peak.rssMB - metrics.memory.start.rssMB) * 100) / 100;

    const tierResult: ScenarioTierResult = {
      scenarioName: "Voice Transcription",
      concurrency,
      totalRequests,
      successfulRequests: successfulCount,
      failedRequests,
      errorRatePercent,
      statusCodes,
      totalDurationMs: computePercentiles(durations),
      throughputReqSec,
      eventLoopLag: metrics.eventLoopLag,
      memory: metrics.memory,
      integrityCheck: {
        passed: errorRatePercent === 0,
        details: `Peak RSS delta: +${rssDeltaMB}MB during ${concurrency} simultaneous ${(audioSizeBytes / (1024 * 1024)).toFixed(0)}MB uploads.`,
      },
    };

    printTierSummaryTable(tierResult);
    results.push(tierResult);

    for (const session of sessions) {
      await harness.cleanUpUser(session.userId);
    }
  }

  return results;
}
