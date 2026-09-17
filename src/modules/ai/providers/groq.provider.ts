import { AppError } from "../../../errors/app.error.js";
import { env } from "../../../config/env.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "./ai-provider.interface.js";

type GroqChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

const DEFAULT_RECOMMENDED_MODEL = "qwen/qwen3.8-27b";
const FALLBACK_MODEL = "groq/compound-mini";

function resolveValidModel(rawModel?: string): string {
  if (!rawModel) return DEFAULT_RECOMMENDED_MODEL;
  const m = rawModel.trim().toLowerCase();
  if (m.includes("llama-3") || m.includes("llama3")) {
    return DEFAULT_RECOMMENDED_MODEL;
  }
  if (m.includes("qwen")) {
    return "qwen/qwen3.8-27b";
  }
  if (m.includes("compound")) {
    return "groq/compound-mini";
  }
  return rawModel.trim();
}

export class GroqProvider implements AIProvider {
  public readonly name = "groq";
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly apiUrl: string;

  constructor(apiKey?: string, defaultModel?: string, timeoutMs?: number) {
    this.apiKey = (apiKey ?? env.GROQ_API_KEY ?? "").trim();
    const rawModel = defaultModel ?? env.AI_MODEL;
    this.defaultModel = resolveValidModel(rawModel);
    this.timeoutMs = timeoutMs ?? env.OLLAMA_TIMEOUT_MS;
    this.apiUrl = "https://api.groq.com/openai/v1/chat/completions";
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: { model?: string; maxTokens?: number },
  ): Promise<AIResponse> {
    if (!this.apiKey) {
      throw new AppError(
        "Groq API key is missing. Please set GROQ_API_KEY in the environment variables.",
        502,
        "AI_PROVIDER_ERROR",
      );
    }

    let targetModel = resolveValidModel(options?.model ?? this.defaultModel);
    // Strict safe output token clamping (600 tokens max) to guarantee pre-flight OTPM limits
    const maxTokens = options?.maxTokens ?? 600;

    // Prune excessive context to prevent payload size / 413 issues
    const sanitizedMessages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
    }));

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: sanitizedMessages,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const data = (await response.json()) as GroqChatCompletionResponse;

      if (!response.ok) {
        const errorMsg = data?.error?.message || `HTTP ${response.status}`;

        // 1. Model not found or deprecated: auto-heal with DEFAULT_RECOMMENDED_MODEL
        if (
          (response.status === 404 || errorMsg.toLowerCase().includes("does not exist")) &&
          targetModel !== DEFAULT_RECOMMENDED_MODEL
        ) {
          console.warn(
            `[GroqProvider] Model "${targetModel}" not found. Auto-recovering with ${DEFAULT_RECOMMENDED_MODEL}...`,
          );
          return this.generateChatResponse(messages, {
            model: DEFAULT_RECOMMENDED_MODEL,
            maxTokens: 600,
          });
        }

        // 2. Rate limit (429) OR Entity Too Large (413): seamless fallback retry
        if (response.status === 429 || response.status === 413 || errorMsg.toLowerCase().includes("too large")) {
          const alternateModel =
            targetModel === DEFAULT_RECOMMENDED_MODEL ? FALLBACK_MODEL : DEFAULT_RECOMMENDED_MODEL;

          console.warn(
            `[GroqProvider] Error (${response.status}: ${errorMsg}) on ${targetModel}. Seamlessly retrying with ${alternateModel}...`,
          );
          return this.generateChatResponse(messages, {
            model: alternateModel,
            maxTokens: 500,
          });
        }

        if (response.status === 401) {
          throw new AppError(
            `Invalid Groq API key: ${errorMsg}`,
            502,
            "AI_PROVIDER_ERROR",
          );
        }

        throw new AppError(
          `Groq API error: ${errorMsg}`,
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const firstChoice = data.choices?.[0];
      if (!firstChoice?.message?.content) {
        throw new AppError(
          "Groq returned an empty response",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const totalTokens = data.usage?.total_tokens ?? (inputTokens + outputTokens);

      return {
        content: firstChoice.message.content,
        provider: this.name,
        model: data.model || targetModel,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
      };
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          error.name === "AbortError" ||
          (error as any).cause?.name === "TimeoutError" ||
          (error as any).cause?.name === "AbortError");

      if (isTimeout) {
        throw new AppError(
          "AI provider request timed out",
          504,
          "AI_PROVIDER_TIMEOUT",
        );
      }

      throw new AppError(
        error instanceof Error ? error.message : "Failed to communicate with AI provider",
        502,
        "AI_PROVIDER_ERROR",
      );
    }
  }
}
