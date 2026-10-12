import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import { User } from "../src/modules/users/user.model.js";
import { getAudioUploadDir } from "../src/middleware/upload.js";

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

const runCleanupVerification = async () => {
  console.log("=== Starting Voice Temp Disk Storage & Cleanup Verification ===");
  await connectDatabase();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = getAudioUploadDir();

  try {
    const testUser = await User.create({
      name: "Cleanup Test User",
      email: `cleanup-test-${Date.now()}@example.com`,
      passwordHash: "dummyHashForTestingOnly12345678",
      roles: ["USER"],
      status: "ACTIVE",
    });
    const token = generateAccessToken({
      sub: testUser._id.toString(),
      email: testUser.email,
      roles: ["USER"],
    });

    const getResidualFiles = () => fs.readdirSync(tempDir);

    console.log("\n[Test 1] Verify temp directory exists and is initially empty...");
    assert.equal(fs.existsSync(tempDir), true);
    assert.equal(getResidualFiles().length, 0);
    console.log("✓ Initial temp directory is empty.");

    console.log("\n[Test 2] Verify temporary file cleanup after successful upload...");
    {
      const wav = createValidWavBuffer(15000);
      const form = new FormData();
      form.append("file", new File([new Uint8Array(wav)], "test.wav", { type: "audio/wav" }));

      const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      assert.equal(res.status, 200);
      // Verify temp file was completely removed
      const remaining = getResidualFiles();
      assert.equal(remaining.length, 0, `Expected 0 files remaining, found: ${remaining}`);
      console.log("✓ Temporary file deleted after successful transcription.");
    }

    console.log("\n[Test 3] Verify temporary file cleanup on invalid MIME type...");
    {
      const textBuffer = Buffer.from("Not an audio file");
      const form = new FormData();
      form.append("file", new File([new Uint8Array(textBuffer)], "test.txt", { type: "text/plain" }));

      const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      assert.equal(res.status, 400);
      const remaining = getResidualFiles();
      assert.equal(remaining.length, 0, `Expected 0 files remaining, found: ${remaining}`);
      console.log("✓ Temporary file deleted on MIME validation failure.");
    }

    console.log("\n[Test 4] Verify temporary file cleanup on too-short audio (< 100 bytes)...");
    {
      const shortBuffer = Buffer.alloc(50);
      const form = new FormData();
      form.append("file", new File([new Uint8Array(shortBuffer)], "short.wav", { type: "audio/wav" }));

      const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      assert.equal(res.status, 400);
      const remaining = getResidualFiles();
      assert.equal(remaining.length, 0, `Expected 0 files remaining, found: ${remaining}`);
      console.log("✓ Temporary file deleted on audio length validation failure.");
    }

    console.log("\n[Test 5] Verify temporary file cleanup on client abort / cancellation...");
    {
      const wav = createValidWavBuffer(200000);
      const form = new FormData();
      form.append("file", new File([new Uint8Array(wav)], "abort.wav", { type: "audio/wav" }));
      const controller = new AbortController();

      const fetchPromise = fetch(`${baseUrl}/api/v1/voice/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: controller.signal,
      });

      // Abort immediately after sending
      setTimeout(() => controller.abort(), 5);

      try {
        await fetchPromise;
      } catch (err) {
        // Expected abort
      }

      // Wait a moment for OS handle release and unlink
      await new Promise((r) => setTimeout(r, 100));
      const remaining = getResidualFiles();
      assert.equal(remaining.length, 0, `Expected 0 files remaining, found: ${remaining}`);
      console.log("✓ Temporary file deleted on client cancellation.");
    }

    console.log("\n[Test 6] Verify concurrent uploads cleanup safely without collisions...");
    {
      const concurrentUploads = 8;
      const promises = Array.from({ length: concurrentUploads }).map(async (_, idx) => {
        const wav = createValidWavBuffer(100000);
        const form = new FormData();
        form.append("file", new File([new Uint8Array(wav)], `concurrent_${idx}.wav`, { type: "audio/wav" }));

        const res = await fetch(`${baseUrl}/api/v1/voice/transcribe`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        return res.status;
      });

      const statuses = await Promise.all(promises);
      assert.ok(statuses.every((s) => s === 200));

      const remaining = getResidualFiles();
      assert.equal(remaining.length, 0, `Expected 0 files remaining after concurrent run, found: ${remaining}`);
      console.log(`✓ All ${concurrentUploads} concurrent uploads completed and cleaned up 100% of temporary files.`);
    }

    await User.deleteOne({ _id: testUser._id });
    console.log("\n========================================================");
    console.log(" ALL VOICE CLEANUP & DISK STORAGE TESTS PASSED (6/6)");
    console.log("========================================================");
  } finally {
    server.close();
    await disconnectDatabase();
  }
};

runCleanupVerification().catch((err) => {
  console.error("Cleanup verification failed:", err);
  process.exit(1);
});
