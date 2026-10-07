import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { VoiceService } from "../src/modules/voice/voice.service.js";
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

    console.log("\n[Scenario 2] Testing VoiceService with missing API key...");
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

    console.log("\n[Scenario 3] Testing VoiceService calling Groq STT API...");
    {
      const service = new VoiceService();
      const validWav = createValidWavBuffer();
      const result = await service.transcribeAudio(validWav, "test.wav", "audio/wav");
      assert.ok(typeof result.text === "string");
      console.log(`✓ VoiceService received transcript from Groq STT: "${result.text}"`);
    }

    console.log("\n[Scenario 4] Testing /api/v1/voice/transcribe unauthenticated...");
    {
      const res = await fetch(`http://localhost:${port}/api/v1/voice/transcribe`, {
        method: "POST",
      });
      assert.equal(res.status, 401);
      const data = await res.json() as any;
      assert.equal(data.error?.code, "UNAUTHORIZED");
      console.log("✓ Unauthenticated request rejected with 401 UNAUTHORIZED");
    }

    console.log("\n[Scenario 5] Testing /api/v1/voice/transcribe without audio file...");
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

    console.log("\n[Scenario 6] Testing /api/v1/voice/transcribe with invalid file type...");
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

    console.log("\n[Scenario 7] Testing /api/v1/voice/transcribe with valid audio upload...");
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
    console.log(" ALL VOICE TRANSCRIPTION TESTS PASSED (7/7)       ");
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