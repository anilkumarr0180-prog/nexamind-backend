import { AppError } from "../../../errors/app.error.js";
import { env } from "../../../config/env.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
  ToolCall,
} from "./ai-provider.interface.js";

type OllamaChatResponse = {
  model: string;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id?: string;
      function: {
        name: string;
        arguments: Record<string, unknown> | string;
      };
    }>;
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
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    const model = options?.model ?? this.defaultModel;
    const url = `${this.baseUrl}/api/chat`;

    const formattedMessages = messages.map((m) => {
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: m.content ?? "",
      };

      if (m.role === "tool" && m.toolCallId) {
        msgObj.tool_call_id = m.toolCallId;
      }

      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        msgObj.tool_calls = m.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments ?? {},
          },
        }));
      }

      return msgObj;
    });

    const requestBody: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      stream: false,
    };

    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
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

      const rawToolCalls = data.message?.tool_calls;
      let parsedToolCalls: ToolCall[] | undefined;

      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        parsedToolCalls = [];
        for (const tc of rawToolCalls) {
          if (tc && tc.function && typeof tc.function.name === "string") {
            let parsedArgs: Record<string, unknown> = {};
            if (typeof tc.function.arguments === "string") {
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                parsedArgs = { raw: tc.function.arguments };
              }
            } else if (
              typeof tc.function.arguments === "object" &&
              tc.function.arguments !== null
            ) {
              parsedArgs = tc.function.arguments;
            }

            parsedToolCalls.push({
              id:
                tc.id ||
                `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: tc.function.name,
              arguments: parsedArgs,
            });
          }
        }
      }

      const content = data.message?.content ?? "";

      if (!content.trim() && (!parsedToolCalls || parsedToolCalls.length === 0)) {
        throw new AppError(
          "Ollama returned an empty response",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const inputTokens = data.prompt_eval_count ?? 0;
      const outputTokens = data.eval_count ?? 0;

      return {
        content,
        provider: this.name,
        model: data.model || model,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        ...(parsedToolCalls && parsedToolCalls.length > 0
          ? { toolCalls: parsedToolCalls }
          : {}),
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

  async *generateChatStream(
    messages: AIMessage[],
    options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    const model = options?.model ?? this.defaultModel;
    const url = `${this.baseUrl}/api/chat`;

    const formattedMessages = messages.map((m) => {
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: m.content ?? "",
      };

      if (m.role === "tool" && m.toolCallId) {
        msgObj.tool_call_id = m.toolCallId;
      }

      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        msgObj.tool_calls = m.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments ?? {},
          },
        }));
      }

      return msgObj;
    });

    const requestBody: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      stream: true,
    };

    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)];
    if (signal) {
      signals.push(signal);
    }
    const combinedSignal = AbortSignal.any(signals);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      });
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) return;
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

    if (!response.ok) {
      throw new AppError(
        `Ollama API returned HTTP ${response.status}`,
        502,
        "AI_PROVIDER_ERROR",
      );
    }

    if (!response.body) {
      throw new AppError("Ollama returned an empty response body", 502, "AI_PROVIDER_ERROR");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          try {
            const data = JSON.parse(line);
            const delta = data.message?.content;
            if (delta) {
              yield {
                content: delta,
                model: data.model || model,
              };
            }

            if (data.done) {
              const inputTokens = data.prompt_eval_count ?? 0;
              const outputTokens = data.eval_count ?? 0;
              yield {
                content: "",
                model: data.model || model,
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                },
                done: true,
              };
              return;
            }
          } catch {
            // Ignore partial NDJSON parsing glitches
          }
        }
      }
    } catch (streamError: unknown) {
      if (signal?.aborted) {
        return;
      }
      if (streamError instanceof AppError) throw streamError;
      const isTimeout =
        streamError instanceof Error &&
        (streamError.name === "TimeoutError" ||
          streamError.name === "AbortError" ||
          (streamError as any).cause?.name === "TimeoutError" ||
          (streamError as any).cause?.name === "AbortError");

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
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
}
