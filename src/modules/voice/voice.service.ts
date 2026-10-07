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

import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import type { TranscriptionResult, TranscribeAudioOptions } from "./voice.types.js";

export const DEFAULT_WHISPER_MODEL = "whisper-large-v3-turbo";
export const FALLBACK_WHISPER_MODEL = "whisper-large-v3";
export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

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

    const apiKey = this.getEffectiveApiKey();
    const model = options?.model || DEFAULT_WHISPER_MODEL;

    const formData = new FormData();
    const file = new File([new Uint8Array(audioBuffer)], filename, { type: mimetype || "audio/webm" });
    formData.append("file", file);
    formData.append("model", model);
    formData.append("response_format", "json");

    if (options?.language) {
      formData.append("language", options.language);
    }
    if (options?.prompt) {
      formData.append("prompt", options.prompt);
    }
    const temperature = typeof options?.temperature === "number" ? options.temperature : 0;
    formData.append("temperature", temperature.toString());

    let response: Response;
    try {
      response = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });
    } catch (networkErr: unknown) {
      throw new AppError(
        `Failed to reach speech-to-text service: ${(networkErr as Error)?.message || "Network error"}`,
        502,
        "VOICE_PROVIDER_NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
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

    const result = (await response.json()) as { text?: string; language?: string; duration?: number };
    let text = (result.text || "").trim();
    if (isSilenceHallucination(text)) {
      text = "";
    }

    return {
      text,
      language: result.language,
      duration: result.duration,
    };
  }
}

export const voiceService = new VoiceService();
