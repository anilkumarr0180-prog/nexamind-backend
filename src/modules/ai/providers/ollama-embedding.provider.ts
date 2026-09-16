import { AppError } from "../../../errors/app.error.js";
import { env } from "../../../config/env.js";
import type { EmbeddingProvider } from "./embedding-provider.interface.js";

type OllamaEmbedResponse = {
  model?: string;
  embeddings?: number[][];
  embedding?: number[];
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "ollama-embedding";
  public readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl?: string,
    model?: string,
    dimensions: number = 768,
    timeoutMs?: number,
  ) {
    this.baseUrl = (baseUrl ?? env.AI_BASE_URL).replace(/\/$/, "");
    this.model = model ?? env.AI_EMBEDDING_MODEL;
    this.dimensions = dimensions;
    this.timeoutMs = timeoutMs ?? env.OLLAMA_TIMEOUT_MS;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new AppError("Cannot generate embedding for empty text", 400, "INVALID_INPUT");
    }

    const url = `${this.baseUrl}/api/embed`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: trimmed,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new AppError(
          `Ollama Embed API returned HTTP ${response.status}`,
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      const embedding = data.embeddings?.[0] ?? data.embedding;

      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        throw new AppError(
          "Ollama Embed API returned an empty or invalid vector",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      return embedding;
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
          "Embedding provider request timed out",
          504,
          "AI_PROVIDER_TIMEOUT",
        );
      }

      throw new AppError(
        "Failed to communicate with embedding provider",
        502,
        "AI_PROVIDER_ERROR",
      );
    }
  }
}
