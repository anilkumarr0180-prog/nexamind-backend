import { AppError } from "../../../errors/app.error.js";
import { env } from "../../../config/env.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
} from "./ai-provider.interface.js";

type OllamaChatResponse = {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};

export class OllamaProvider implements AIProvider {
  public readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(baseUrl?: string, defaultModel?: string, timeoutMs?: number) {
    this.baseUrl = (baseUrl ?? env.AI_BASE_URL).replace(/\/$/, "");
    this.defaultModel = defaultModel ?? env.AI_MODEL;
    this.timeoutMs = timeoutMs ?? env.OLLAMA_TIMEOUT_MS;
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: { model?: string },
  ): Promise<AIResponse> {
    const model = options?.model ?? this.defaultModel;
    const url = `${this.baseUrl}/api/chat`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new AppError(
          `Ollama API returned HTTP ${response.status}`,
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const data = (await response.json()) as OllamaChatResponse;

      if (!data.message?.content) {
        throw new AppError(
          "Ollama returned an empty response",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const inputTokens = data.prompt_eval_count ?? 0;
      const outputTokens = data.eval_count ?? 0;

      return {
        content: data.message.content,
        provider: this.name,
        model: data.model || model,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
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
        "Failed to communicate with AI provider",
        502,
        "AI_PROVIDER_ERROR",
      );
    }
  }
}
