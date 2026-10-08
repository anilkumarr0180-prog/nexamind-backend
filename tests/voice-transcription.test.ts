import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import {
  VoiceService,
  normalizeAudioFilenameAndMime,
  DEFAULT_WHISPER_MODEL,
} from "../src/modules/voice/voice.service.js";
import { AppError } from "../src/errors/app.error.js";
import { env } from "../src/config/env.js";

function createValidWavBuffer(): Buffer {
  const sampleRate = 16000;
  const numSamples = sampleRate * 1;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const runTests = async () => {
  console.log("=== Starting NexaMind Voice: Step 2 Audio Transcription Tests ===");
  await connectDatabase();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const testUser = await User.create({
      name: "Voice Test User",
      email: `voice-test-${Date.now()}@example.com`,
      passwordHash: "dummyHashForTestingOnly12345678",
      roles: ["USER"],
      status: "ACTIVE",
    });
    const token = generateAccessToken({
      sub: testUser._id.toString(),
      email: testUser.email,
      roles: ["USER"],
    });

    console.log("\n[Scenario 1] Testing VoiceService with empty audio buffer...");
    {
      const service = new VoiceService();
      await assert.rejects(
        async () => {
          await service.transcribeAudio(Buffer.alloc(0), "empty.webm", "audio/webm");
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal((err as AppError).statusCode, 400);
          assert.equal((err as AppError).code, "INVALID_AUDIO");
          return true;
        },
      );
      console.log("✓ Empty audio buffer safely rejected with AppError(400, INVALID_AUDIO)");
    }

    console.log("\n[Scenario 2] Testing VoiceService with too-short audio buffer (< 100 bytes)...");
    {
      const service = new VoiceService();
      await assert.rejects(
        async () => {
          await service.transcribeAudio(Buffer.alloc(50), "short.webm", "audio/webm");
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal((err as AppError).statusCode, 400);
          assert.equal((err as AppError).code, "INVALID_AUDIO");
          return true;
        },
      );
      console.log("✓ Too-short audio buffer safely rejected with AppError(400, INVALID_AUDIO)");
    }

    console.log("\n[Scenario 3] Testing normalizeAudioFilenameAndMime consistency...");
    {
      const norm1 = normalizeAudioFilenameAndMime("blob", "audio/webm;codecs=opus");
      assert.equal(norm1.filename, "recording.webm");
      assert.equal(norm1.mimetype, "audio/webm");

      const norm2 = normalizeAudioFilenameAndMime("speech.opus", "audio/ogg;codecs=opus");
      assert.equal(norm2.filename, "speech.ogg");
      assert.equal(norm2.mimetype, "audio/ogg");

      const norm3 = normalizeAudioFilenameAndMime("safari_audio", "audio/mp4");
      assert.equal(norm3.filename, "safari_audio.m4a");
      assert.equal(norm3.mimetype, "audio/mp4");

      const norm4 = normalizeAudioFilenameAndMime("valid.wav", "audio/wav");
      assert.equal(norm4.filename, "valid.wav");
      assert.equal(norm4.mimetype, "audio/wav");

      console.log("✓ Filename and MIME type normalization maintains Groq Whisper format consistency");
    }

    console.log("\n[Scenario 4] Testing VoiceService with missing API key...");
    {
      const service = new VoiceService("");
      const validWav = createValidWavBuffer();
      const origKey = env.GROQ_API_KEY;
      (env as any).GROQ_API_KEY = "";
      try {
        await assert.rejects(
          async () => {
            await service.transcribeAudio(validWav, "test.wav", "audio/wav");
          },
          (err: unknown) => {
            assert.ok(err instanceof AppError);
            assert.equal((err as AppError).statusCode, 502);
            assert.equal((err as AppError).code, "VOICE_PROVIDER_ERROR");
            return true;
          },
        );
      } finally {
        (env as any).GROQ_API_KEY = origKey;
      }
      console.log("✓ Missing Groq API key safely rejected with AppError(502, VOICE_PROVIDER_ERROR)");
    }

    console.log("\n[Scenario 5] Testing VoiceService timeout handling...");
    {
      const service = new VoiceService();
      const validWav = createValidWavBuffer();
      await assert.rejects(
        async () => {
          // Timeout after 1ms to trigger the timeout handler reliably
          await service.transcribeAudio(validWav, "test.wav", "audio/wav", { timeoutMs: 1 });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal((err as AppError).statusCode, 504);
          assert.equal((err as AppError).code, "VOICE_PROVIDER_TIMEOUT");
          return true;
        },
      );
      console.log("✓ Request timeout safely aborts and raises AppError(504, VOICE_PROVIDER_TIMEOUT)");
    }

    console.log("\n[Scenario 6] Testing VoiceService client cancellation handling...");
    {
      const service = new VoiceService();
      const validWav = createValidWavBuffer();
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        async () => {
          await service.transcribeAudio(validWav, "test.wav", "audio/wav", { signal: controller.signal });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal((err as AppError).statusCode, 499);
          assert.equal((err as AppError).code, "REQUEST_CANCELLED");
          return true;
        },
      );
      console.log("✓ Pre-aborted signal safely throws AppError(499, REQUEST_CANCELLED)");
    }

    console.log("\n[Scenario 7] Testing VoiceService calling Groq STT API...");
    {
      const service = new VoiceService();
      const validWav = createValidWavBuffer();
      const result = await service.transcribeAudio(validWav, "test.wav", "audio/wav");
      assert.ok(typeof result.text === "string");
      console.log(`✓ VoiceService received transcript from Groq STT: "${result.text}"`);
    }

    console.log("\n[Scenario 8] Testing /api/v1/voice/transcribe unauthenticated...");
    {
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
      });
      assert.equal(res.status, 401);
      const data = await res.json() as any;
      assert.equal(data.error?.code, "UNAUTHORIZED");
      console.log("✓ Unauthenticated request rejected with 401 UNAUTHORIZED");
    }

    console.log("\n[Scenario 9] Testing /api/v1/voice/transcribe without audio file...");
    {
      const emptyForm = new FormData();
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: emptyForm,
      });
      assert.equal(res.status, 400);
      const data = await res.json() as any;
      assert.equal(data.error?.code, "MISSING_FILE");
      console.log("✓ Request without audio file rejected with 400 MISSING_FILE");
    }

    console.log("\n[Scenario 10] Testing /api/v1/voice/transcribe with invalid file type...");
    {
      const badForm = new FormData();
      const fakeText = new File([Buffer.from("hello world")], "test.txt", { type: "text/plain" });
      badForm.append("file", fakeText);
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: badForm,
      });
      assert.equal(res.status, 400);
      const data = await res.json() as any;
      assert.equal(data.error?.code, "INVALID_MIME_TYPE");
      console.log("✓ Non-audio file rejected with 400 INVALID_MIME_TYPE");
    }

    console.log("\n[Scenario 11] Testing /api/v1/voice/transcribe with too-short audio file (< 100 bytes)...");
    {
      const tinyForm = new FormData();
      const tinyAudio = new File([new Uint8Array(40)], "recording.webm", { type: "audio/webm" });
      tinyForm.append("file", tinyAudio);
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: tinyForm,
      });
      assert.equal(res.status, 400);
      const data = await res.json() as any;
      assert.equal(data.error?.code, "INVALID_AUDIO");
      console.log("✓ Too-short audio rejected with 400 INVALID_AUDIO");
    }

    console.log("\n[Scenario 12] Testing /api/v1/voice/transcribe with valid audio upload...");
    {
      const validWav = createValidWavBuffer();
      const form = new FormData();
      const audioFile = new File([new Uint8Array(validWav)], "recording.wav", { type: "audio/wav" });
      form.append("file", audioFile);
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
      });
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.success, true);
      assert.ok(typeof data.data?.text === "string");
      console.log(`✓ Successful audio transcription returned: "${data.data.text}"`);
    }

    console.log("\n==================================================");
    console.log(" ALL VOICE TRANSCRIPTION TESTS PASSED (12/12)     ");
    console.log("==================================================\n");
  } finally {
    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Voice Transcription Tests Failed:", err);
  process.exit(1);
});
