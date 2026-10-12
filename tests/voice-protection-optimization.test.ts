import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import {
  getAudioUploadDir,
  MAX_AUDIO_FILE_SIZE,
} from "../src/middleware/upload.js";
import {
  voiceRateLimiter,
  voiceRateLimitStore,
  resetVoiceRateLimit,
} from "../src/middleware/rate-limit.js";
import {
  VoiceService,
  MAX_TRANSCRIPTION_RETRIES,
  DEFAULT_WHISPER_MODEL,
  FALLBACK_WHISPER_MODEL,
} from "../src/modules/voice/voice.service.js";
import { AppError } from "../src/errors/app.error.js";

function createValidWavBuffer(sizeBytes: number = 2000): Buffer {
  const sampleRate = 16000;
  const dataSize = Math.max(0, sizeBytes - 44);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 44; i < buffer.length; i += 2) {
    buffer.writeInt16LE(1000, i);
  }
  return buffer;
}

async function runVoiceProtectionTests() {
  console.log("==========================================================================");
  console.log("=== NEXAMIND VOICE ENDPOINT PROTECTION & RELIABILITY TEST SUITE ===");
  console.log("==========================================================================");

  await connectDatabase();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = getAudioUploadDir();

  const createdUserIds: string[] = [];

  const getResidualFiles = () => {
    if (!fs.existsSync(tempDir)) return [];
    return fs.readdirSync(tempDir);
  };

  try {
    const testUser = await User.create({
      name: "Voice Protect User",
      email: `voice-protect-${Date.now()}@example.com`,
      passwordHash: "dummyHashForTestingOnly12345678",
      roles: ["USER"],
      status: "ACTIVE",
    });
    createdUserIds.push(testUser._id.toString());

    const token = generateAccessToken({
      sub: testUser._id.toString(),
      email: testUser.email,
      roles: ["USER"],
    });

    const otherUser = await User.create({
      name: "Voice Other User",
      email: `voice-other-${Date.now()}@example.com`,
      passwordHash: "dummyHashForTestingOnly12345678",
      roles: ["USER"],
      status: "ACTIVE",
    });
    createdUserIds.push(otherUser._id.toString());

    const otherToken = generateAccessToken({
      sub: otherUser._id.toString(),
      email: otherUser.email,
      roles: ["USER"],
    });

    // -----------------------------------------------------------------------
    // TEST 1: RATE LIMITING KEYED BY AUTHENTICATED USER & RESET
    // -----------------------------------------------------------------------
    console.log("\n[Test 1] Testing authenticated user rate-limiting & independent user quotas...");
    await resetVoiceRateLimit();

    const wav1k = createValidWavBuffer(2000);
    const formUpload = () => {
      const f = new FormData();
      f.append("file", new File([new Uint8Array(wav1k)], "voice.wav", { type: "audio/wav" }));
      return f;
    };

    // Make 20 requests (the limit)
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formUpload(),
      });
      assert.strictEqual(res.status, 200, `Request ${i + 1} within limit should succeed`);
    }

    // 21st request by same user must be rate-limited (HTTP 429)
    const rateLimitedRes = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formUpload(),
    });
    assert.strictEqual(rateLimitedRes.status, 429, "21st request must receive HTTP 429");
    const rateLimitBody = await rateLimitedRes.json() as any;
    assert.strictEqual(rateLimitBody.error?.code, "TOO_MANY_REQUESTS");
    assert.ok(rateLimitBody.error?.message.includes("voice transcription"));

    // Verify rate limiting happens BEFORE multipart parsing & temp file creation
    // The rate limited request must NOT have created any residual files!
    assert.strictEqual(
      getResidualFiles().length,
      0,
      "Rate-limited request must not leave any temporary file on disk",
    );

    // Verify other authenticated user is NOT affected (independent user quota)
    const otherUserRes = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}` },
      body: formUpload(),
    });
    assert.strictEqual(otherUserRes.status, 200, "Different user has independent rate-limit bucket");

    // Test rate-limit reset
    await resetVoiceRateLimit();
    const afterResetRes = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formUpload(),
    });
    assert.strictEqual(afterResetRes.status, 200, "Reset restores quota immediately");
    console.log("✓ Test 1 Passed: User-keyed rate-limiting, pre-parsing rejection, and reset verified.");

    // -----------------------------------------------------------------------
    // TEST 2: OVERSIZED AUDIO (10 MB LIMIT)
    // -----------------------------------------------------------------------
    console.log("\n[Test 2] Testing 10 MB audio file upload size boundary...");
    assert.strictEqual(MAX_AUDIO_FILE_SIZE, 10 * 1024 * 1024, "MAX_AUDIO_FILE_SIZE must be exactly 10MB");

    // 10.5 MB oversized audio
    const oversizedBytes = 10.5 * 1024 * 1024;
    const oversizedBuffer = Buffer.alloc(oversizedBytes);
    oversizedBuffer.write("RIFF", 0);
    oversizedBuffer.write("WAVE", 8);

    const overForm = new FormData();
    overForm.append("file", new File([new Uint8Array(oversizedBuffer)], "oversized.wav", { type: "audio/wav" }));

    const overRes = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: overForm,
    });

    assert.strictEqual(overRes.status, 400, "Oversized upload must be rejected with HTTP 400");
    const overBody = await overRes.json() as any;
    assert.strictEqual(overBody.error?.code, "FILE_TOO_LARGE");
    assert.ok(overBody.error?.message.includes("10MB"));

    // Verify temporary disk file cleaned up
    assert.strictEqual(getResidualFiles().length, 0, "No residual files on oversized upload failure");
    console.log("✓ Test 2 Passed: 10 MB maximum audio upload size strictly enforced and cleaned up.");

    // -----------------------------------------------------------------------
    // TEST 3: UNSUPPORTED AUDIO FORMAT
    // -----------------------------------------------------------------------
    console.log("\n[Test 3] Testing unsupported audio format rejection & cleanup...");
    const badForm = new FormData();
    badForm.append("file", new File([Buffer.from("fake executable or text content")], "script.exe", { type: "application/x-msdownload" }));

    const badRes = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: badForm,
    });
    assert.strictEqual(badRes.status, 400);
    const badBody = await badRes.json() as any;
    assert.strictEqual(badBody.error?.code, "INVALID_MIME_TYPE");
    assert.strictEqual(getResidualFiles().length, 0, "No residual files on MIME validation failure");
    console.log("✓ Test 3 Passed: Unsupported audio format rejected with 400 INVALID_MIME_TYPE and cleaned up.");

    // -----------------------------------------------------------------------
    // TEST 4: TRANSIENT PROVIDER ERROR WITH BOUNDED RETRY & BACKOFF
    // -----------------------------------------------------------------------
    console.log("\n[Test 4] Testing bounded retry policy & backoff on transient 500/502/503/429 errors...");
    {
      const service = new VoiceService("dummy-groq-key");
      let attemptsCount = 0;
      const originalFetch = globalThis.fetch;

      // Mock fetch: fail first 2 attempts with transient 503, succeed on 3rd attempt
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof input === "string" ? input : (input as URL).toString();
        if (urlStr.includes("api.groq.com")) {
          attemptsCount++;
          if (attemptsCount <= 2) {
            return new Response(JSON.stringify({ error: { message: "Groq Service Unavailable (Simulated)" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ text: "Transcription succeeded after retry", language: "en", duration: 1.5 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const t0 = Date.now();
        const result = await service.transcribeAudio(wav1k, "retry.wav", "audio/wav");
        const elapsed = Date.now() - t0;

        assert.strictEqual(attemptsCount, 3, "Must have retried exactly 2 times (3 attempts total)");
        assert.strictEqual(result.text, "Transcription succeeded after retry");
        // Backoff delay: attempt 0 (200ms) + attempt 1 (400ms) = ~600ms minimum backoff
        assert.ok(elapsed >= 500, `Exponential backoff was observed (${elapsed}ms >= 500ms)`);
        console.log(`✓ Test 4 Passed: Transient 503 retried ${attemptsCount - 1} times with backoff (${elapsed}ms) and succeeded.`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -----------------------------------------------------------------------
    // TEST 5: PERMANENT PROVIDER FAILURE (NOT RETRIED)
    // -----------------------------------------------------------------------
    console.log("\n[Test 5] Testing permanent provider failures are NOT retried...");
    {
      const service = new VoiceService("dummy-groq-key");
      let attemptsCount = 0;
      const originalFetch = globalThis.fetch;

      // Mock fetch: 400 Bad Request (permanent error)
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof input === "string" ? input : (input as URL).toString();
        if (urlStr.includes("api.groq.com")) {
          attemptsCount++;
          return new Response(JSON.stringify({ error: { message: "Unrecognized audio encoding" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        await assert.rejects(
          async () => {
            await service.transcribeAudio(wav1k, "bad_encoding.wav", "audio/wav");
          },
          (err: unknown) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual((err as AppError).statusCode, 400);
            assert.strictEqual((err as AppError).code, "INVALID_AUDIO_REQUEST");
            return true;
          },
        );
        assert.strictEqual(attemptsCount, 1, "Permanent 400 error must NOT be retried (called exactly 1 time)");
        console.log("✓ Test 5 Passed: Permanent provider error (400) rejected immediately without retrying.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -----------------------------------------------------------------------
    // TEST 6: CLIENT CANCELLATION WITHOUT RETRY
    // -----------------------------------------------------------------------
    console.log("\n[Test 6] Testing client cancellation does NOT retry & cleans up immediately...");
    {
      const service = new VoiceService("dummy-groq-key");
      let attemptsCount = 0;
      const originalFetch = globalThis.fetch;
      const abortCtrl = new AbortController();

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof input === "string" ? input : (input as URL).toString();
        if (urlStr.includes("api.groq.com")) {
          attemptsCount++;
          // Abort during first attempt
          abortCtrl.abort();
          throw new Error("CLIENT_ABORTED");
        }
        return originalFetch(input, init);
      };

      try {
        await assert.rejects(
          async () => {
            await service.transcribeAudio(wav1k, "cancel.wav", "audio/wav", {
              signal: abortCtrl.signal,
            });
          },
          (err: unknown) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual((err as AppError).statusCode, 499);
            assert.strictEqual((err as AppError).code, "REQUEST_CANCELLED");
            return true;
          },
        );
        assert.strictEqual(attemptsCount, 1, "Cancelled request must NEVER retry");
        console.log("✓ Test 6 Passed: Client cancellation threw 499 REQUEST_CANCELLED with zero retries.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -----------------------------------------------------------------------
    // TEST 7: TEMPORARY FILE CLEANUP UNDER ALL CONDITIONS
    // -----------------------------------------------------------------------
    console.log("\n[Test 7] Verifying 100% temporary file cleanup across all states...");
    const remainingFiles = getResidualFiles();
    assert.strictEqual(
      remainingFiles.length,
      0,
      `Expected 0 residual files in ${tempDir}, found: ${remainingFiles.join(", ")}`,
    );
    console.log("✓ Test 7 Passed: Temporary upload directory is clean (0 leftover files).");

    console.log("\n==========================================================================");
    console.log("=== ALL VOICE ENDPOINT PROTECTION TESTS PASSED (7/7) ===");
    console.log("==========================================================================\n");
  } finally {
    server.close();
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await disconnectDatabase();
  }
}

runVoiceProtectionTests().catch((err) => {
  console.error("Voice Protection Tests Failed:", err);
  process.exit(1);
});
