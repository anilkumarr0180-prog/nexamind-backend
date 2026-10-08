import path from "node:path";
import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import type { TranscriptionResult, TranscribeAudioOptions } from "./voice.types.js";

export const DEFAULT_WHISPER_MODEL = "whisper-large-v3-turbo";
export const FALLBACK_WHISPER_MODEL = "whisper-large-v3";
export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 25000;

export const GROQ_SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".ogg",
  ".wav",
  ".webm",
]);

export function normalizeAudioFilenameAndMime(
  originalFilename: string = "recording.webm",
  rawMimetype: string = "audio/webm",
): { filename: string; mimetype: string } {
  const cleanMime = (rawMimetype || "").toLowerCase().split(";")[0]?.trim() || "audio/webm";
  let ext = path.extname(originalFilename || "").toLowerCase();

  if (GROQ_SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
    const rawBase = path.basename(originalFilename || "recording", ext);
    const sanitizedBase = rawBase && rawBase !== "blob" ? rawBase.replace(/[^a-zA-Z0-9_-]/g, "_") : "recording";
    return {
      filename: `${sanitizedBase}${ext}`,
      mimetype: cleanMime,
    };
  }

  // Map unknown or missing extensions based on MIME type
  if (cleanMime.includes("webm")) {
    ext = ".webm";
  } else if (cleanMime.includes("mp4") || cleanMime.includes("m4a") || cleanMime.includes("aac")) {
    ext = ".m4a";
  } else if (cleanMime.includes("ogg") || cleanMime.includes("opus") || cleanMime.includes("oga")) {
    ext = ".ogg";
  } else if (cleanMime.includes("wav")) {
    ext = ".wav";
  } else if (cleanMime.includes("mpeg") || cleanMime.includes("mp3")) {
    ext = ".mp3";
  } else if (cleanMime.includes("flac")) {
    ext = ".flac";
  } else {
    ext = ".webm";
  }

  const rawBase = path.basename(originalFilename || "recording", path.extname(originalFilename || ""));
  const sanitizedBase = rawBase && rawBase !== "blob" ? rawBase.replace(/[^a-zA-Z0-9_-]/g, "_") : "recording";

  return {
    filename: `${sanitizedBase}${ext}`,
    mimetype: cleanMime,
  };
}

export function isSilenceHallucination(text: string): boolean {
  if (!text) return true;
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()"'`\-—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return true;
  const words = cleaned.split(" ");
  if (words.every((w) => w === "thank" || w === "you" || w === "thanks")) {
    return true;
  }
  if (
    cleaned === "thank you very much" ||
    cleaned === "thank you for watching" ||
    cleaned === "thanks for watching" ||
    cleaned.startsWith("subtitles by") ||
    cleaned.startsWith("please subscribe") ||
    cleaned.startsWith("like and subscribe")
  ) {
    return true;
  }
  return false;
}

export class VoiceService {
  constructor(private readonly apiKey?: string) {}

  private getEffectiveApiKey(): string {
    const key = this.apiKey || env.GROQ_API_KEY;
    if (!key || key.trim().length === 0) {
      throw new AppError(
        "Groq API key is missing. Please set GROQ_API_KEY in the environment variables.",
        502,
        "VOICE_PROVIDER_ERROR",
      );
    }
    return key.trim();
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    filename: string = "audio.webm",
    mimetype: string = "audio/webm",
    options?: TranscribeAudioOptions,
  ): Promise<TranscriptionResult> {
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new AppError("Audio data cannot be empty", 400, "INVALID_AUDIO");
    }

    if (audioBuffer.length < 100) {
      throw new AppError(
        "Audio recording is too short or empty. Please speak into the microphone.",
        400,
        "INVALID_AUDIO",
      );
    }

    const apiKey = this.getEffectiveApiKey();
    const normalized = normalizeAudioFilenameAndMime(filename, mimetype);
    const timeoutMs = options?.timeoutMs || DEFAULT_TRANSCRIPTION_TIMEOUT_MS;

    
    const executeGroqRequest = async (modelToUse: string): Promise<Response> => {
      const formData = new FormData();
      const file = new File([new Uint8Array(audioBuffer)], normalized.filename, {
        type: normalized.mimetype,
      });
      formData.append("file", file);
      formData.append("model", modelToUse);
      formData.append("response_format", "json");

      if (options?.language) {
        formData.append("language", options.language);
      }
      if (options?.prompt) {
        formData.append("prompt", options.prompt);
      }
      const temperature = typeof options?.temperature === "number" ? options.temperature : 0;
      formData.append("temperature", temperature.toString());

      const controller = new AbortController();
      let isTimeout = false;
      const timeoutId = setTimeout(() => {
        isTimeout = true;
        controller.abort(new Error("GROQ_TIMEOUT"));
      }, timeoutMs);

      let abortListener: (() => void) | undefined;
      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId);
          throw new AppError("Transcription was cancelled", 499, "REQUEST_CANCELLED");
        }
        abortListener = () => {
          controller.abort(new Error("CLIENT_ABORTED"));
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      try {
        const res = await fetch(GROQ_TRANSCRIPTION_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
          signal: controller.signal,
        });
        return res;
      } catch (networkErr: unknown) {
        if (options?.signal?.aborted || (networkErr as Error)?.message === "CLIENT_ABORTED") {
          throw new AppError("Transcription was cancelled", 499, "REQUEST_CANCELLED");
        }
        if (isTimeout || controller.signal.aborted || (networkErr as Error)?.name === "TimeoutError" || (networkErr as Error)?.message === "GROQ_TIMEOUT") {
          throw new AppError(
            "Speech-to-text service timed out. Please try again with a shorter recording.",
            504,
            "VOICE_PROVIDER_TIMEOUT",
          );
        }
        throw new AppError(
          `Failed to reach speech-to-text service: ${(networkErr as Error)?.message || "Network error"}`,
          502,
          "VOICE_PROVIDER_NETWORK_ERROR",
        );
      } finally {
        clearTimeout(timeoutId);
        if (options?.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
      }
    };

    let model = options?.model || DEFAULT_WHISPER_MODEL;
    let response = await executeGroqRequest(model);

    // Fallback to FALLBACK_WHISPER_MODEL if turbo model suffers temporary 500, 502, or 503
    if (!response.ok && (response.status === 500 || response.status === 502 || response.status === 503) && model === DEFAULT_WHISPER_MODEL) {
            try {
        const fallbackRes = await executeGroqRequest(FALLBACK_WHISPER_MODEL);
        if (fallbackRes.ok) {
          response = fallbackRes;
          model = FALLBACK_WHISPER_MODEL;
        }
      } catch {
        // Fallback attempt failed, continue to process primary response error
      }
    }

    const rawResponseText = await response.text();
    
    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = JSON.parse(rawResponseText);
      } catch {
        // non-json response
      }

      const errMsg =
        errorBody?.error?.message ||
        `Speech-to-text request failed with status ${response.status}`;

      if (response.status === 400) {
        throw new AppError(errMsg, 400, "INVALID_AUDIO_REQUEST");
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError("Invalid or unauthorized Groq API key", 502, "VOICE_AUTH_ERROR");
      }
      if (response.status === 429) {
        throw new AppError("Speech-to-text rate limit exceeded. Please try again shortly.", 429, "RATE_LIMIT_EXCEEDED");
      }

      throw new AppError(errMsg, 502, "VOICE_PROVIDER_ERROR");
    }

    let result: { text?: string; language?: string; duration?: number } = {};
    try {
      result = JSON.parse(rawResponseText);
    } catch {}

    const rawText = result.text || "";
    let text = rawText.trim();
    const hallucinationDetected = isSilenceHallucination(text);
    if (hallucinationDetected) {
            text = "";
    } else {
          }

    return {
      text,
      language: result.language,
      duration: result.duration,
    };
  }
}

export const voiceService = new VoiceService();
