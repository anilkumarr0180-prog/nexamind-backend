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

export class GroqProvider implements AIProvider {
  public readonly name = "groq";
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly apiUrl: string;

  constructor(apiKey?: string, defaultModel?: string, timeoutMs?: number) {
    this.apiKey = (apiKey ?? env.GROQ_API_KEY ?? "").trim();
    this.defaultModel = defaultModel ?? env.AI_MODEL ?? "qwen/qwen3.8-27b";
    this.timeoutMs = timeoutMs ?? env.OLLAMA_TIMEOUT_MS;
    this.apiUrl = "https://api.groq.com/openai/v1/chat/completions";
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: { model?: string },
  ): Promise<AIResponse> {
    if (!this.apiKey) {
      throw new AppError(
        "Groq API key is missing. Please set GROQ_API_KEY in the environment variables.",
        502,
        "AI_PROVIDER_ERROR",
      );
    }

    const model = options?.model ?? this.defaultModel;

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const data = (await response.json()) as GroqChatCompletionResponse;

      if (!response.ok) {
        const errorMsg = data?.error?.message || `HTTP ${response.status}`;
        if (response.status === 401) {
          throw new AppError(
            `Invalid Groq API key: ${errorMsg}`,
            502,
            "AI_PROVIDER_ERROR",
          );
        }
        if (response.status === 429) {
          throw new AppError(
            `Groq rate limit reached: ${errorMsg}`,
            429,
            "AI_PROVIDER_RATE_LIMIT",
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
        model: data.model || model,
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
