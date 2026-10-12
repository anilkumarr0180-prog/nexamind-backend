/**
 * Synthetic Audio Generator for NexaMind Voice Load Testing
 *
 * Generates structurally valid, uncompressed PCM WAV audio buffers of arbitrary target size
 * (e.g. 5 MB to 10 MB) directly in memory without disk I/O or external network downloads.
 */

export function generateTestWavBuffer(targetSizeBytes: number): Buffer {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  // 44-byte standard RIFF PCM header
  const dataSize = Math.max(0, targetSizeBytes - 44);
  const buffer = Buffer.alloc(44 + dataSize);

  // 1. Chunk ID "RIFF"
  buffer.write("RIFF", 0);
  // 2. Chunk Size (4 + (8 + subchunk1Size) + (8 + subchunk2Size)) = 36 + dataSize
  buffer.writeUInt32LE(36 + dataSize, 4);
  // 3. Format "WAVE"
  buffer.write("WAVE", 8);

  // 4. Subchunk1 ID "fmt "
  buffer.write("fmt ", 12);
  // 5. Subchunk1 Size (16 for PCM)
  buffer.writeUInt32LE(16, 16);
  // 6. Audio Format (1 = PCM)
  buffer.writeUInt16LE(1, 20);
  // 7. Num Channels (1)
  buffer.writeUInt16LE(numChannels, 22);
  // 8. Sample Rate (16000)
  buffer.writeUInt32LE(sampleRate, 24);
  // 9. Byte Rate (32000)
  buffer.writeUInt32LE(byteRate, 28);
  // 10. Block Align (2)
  buffer.writeUInt16LE(blockAlign, 32);
  // 11. Bits Per Sample (16)
  buffer.writeUInt16LE(bitsPerSample, 34);

  // 12. Subchunk2 ID "data"
  buffer.write("data", 36);
  // 13. Subchunk2 Size
  buffer.writeUInt32LE(dataSize, 40);

  // Fill PCM payload with synthesized audio tone (440Hz sine wave) so it passes silence detectors
  const freq = 440;
  const totalSamples = dataSize / bytesPerSample;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.floor(Math.sin(2 * Math.PI * freq * t) * 12000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  return buffer;
}

export const AUDIO_5MB = 5 * 1024 * 1024;
export const AUDIO_10MB = 10 * 1024 * 1024;
