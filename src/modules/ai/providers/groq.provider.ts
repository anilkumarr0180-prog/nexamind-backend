import { AppError } from "../../../errors/app.error.js";
import { env } from "../../../config/env.js";
import { NEXAMIND_CHAT_SYSTEM_PROMPT } from "../prompts/system.prompt.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
  ToolCall,
} from "./ai-provider.interface.js";

type GroqChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
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
    options?: ChatResponseOptions,
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

    // Format and sanitize messages for OpenAI/Groq API compatibility
    const sanitizedMessages = messages.map((m) => {
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      };

      if (m.role === "tool" && m.toolCallId) {
        msgObj.tool_call_id = m.toolCallId;
      }

      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        msgObj.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }

      return msgObj;
    });

    if (!messages.some((m) => m.role === "system")) {
      sanitizedMessages.unshift({
        role: "system",
        content: NEXAMIND_CHAT_SYSTEM_PROMPT,
      });
    }

    const requestBody: Record<string, unknown> = {
      model: targetModel,
      messages: sanitizedMessages,
      max_tokens: maxTokens,
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
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
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
            ...options,
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
            ...options,
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
      if (!firstChoice?.message) {
        throw new AppError(
          "Groq returned an empty response",
          502,
          "AI_PROVIDER_ERROR",
        );
      }

      const rawToolCalls = firstChoice.message.tool_calls;
      let parsedToolCalls: ToolCall[] | undefined;

      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        parsedToolCalls = [];
        for (const tc of rawToolCalls) {
          if (tc && tc.function && typeof tc.function.name === "string") {
            let parsedArgs: Record<string, unknown> = {};
            if (typeof tc.function.arguments === "string" && tc.function.arguments.trim()) {
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                console.warn(`[GroqProvider] Failed to parse tool arguments for "${tc.function.name}":`, tc.function.arguments);
                parsedArgs = { raw: tc.function.arguments };
              }
            } else if (typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
              parsedArgs = tc.function.arguments as Record<string, unknown>;
            }

            parsedToolCalls.push({
              id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: tc.function.name,
              arguments: parsedArgs,
            });
          }
        }
      }

      const content = firstChoice.message.content ?? "";

      // Only treat as error if content is empty AND no valid tool calls were returned
      if (!content.trim() && (!parsedToolCalls || parsedToolCalls.length === 0)) {
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
        content,
        provider: this.name,
        model: data.model || targetModel,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        ...(parsedToolCalls && parsedToolCalls.length > 0 ? { toolCalls: parsedToolCalls } : {}),
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

  async *generateChatStream(
    messages: AIMessage[],
    options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    if (!this.apiKey) {
      throw new AppError(
        "Groq API key is missing. Please set GROQ_API_KEY in the environment variables.",
        502,
        "AI_PROVIDER_ERROR",
      );
    }

    let targetModel = resolveValidModel(options?.model ?? this.defaultModel);
    const maxTokens = options?.maxTokens ?? 600;

    const sanitizedMessages = messages.map((m) => {
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      };

      if (m.role === "tool" && m.toolCallId) {
        msgObj.tool_call_id = m.toolCallId;
      }

      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        msgObj.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }

      return msgObj;
    });

    if (!messages.some((m) => m.role === "system")) {
      sanitizedMessages.unshift({
        role: "system",
        content: NEXAMIND_CHAT_SYSTEM_PROMPT,
      });
    }

    const requestBody: Record<string, unknown> = {
      model: targetModel,
      messages: sanitizedMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
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
      response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
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
        error instanceof Error ? error.message : "Failed to communicate with AI provider",
        502,
        "AI_PROVIDER_ERROR",
      );
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      try {
        const errorData = (await response.json()) as any;
        errorMsg = errorData?.error?.message || errorMsg;
      } catch {}

      if (
        (response.status === 404 || errorMsg.toLowerCase().includes("does not exist")) &&
        targetModel !== DEFAULT_RECOMMENDED_MODEL
      ) {
        console.warn(
          `[GroqProvider] Model "${targetModel}" not found. Auto-recovering stream with ${DEFAULT_RECOMMENDED_MODEL}...`,
        );
        yield* this.generateChatStream(
          messages,
          {
            ...options,
            model: DEFAULT_RECOMMENDED_MODEL,
            maxTokens: 600,
          },
          signal,
        );
        return;
      }

      if (response.status === 429 || response.status === 413 || errorMsg.toLowerCase().includes("too large")) {
        const alternateModel =
          targetModel === DEFAULT_RECOMMENDED_MODEL ? FALLBACK_MODEL : DEFAULT_RECOMMENDED_MODEL;

        console.warn(
          `[GroqProvider] Error (${response.status}: ${errorMsg}) on ${targetModel}. Seamlessly retrying stream with ${alternateModel}...`,
        );
        yield* this.generateChatStream(
          messages,
          {
            ...options,
            model: alternateModel,
            maxTokens: 500,
          },
          signal,
        );
        return;
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

    if (!response.body) {
      throw new AppError("Groq returned an empty response body", 502, "AI_PROVIDER_ERROR");
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
          if (!line || line.startsWith(":")) continue;

          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) {
                const errorMsg = parsed.error.message || "Groq API stream error";
                throw new AppError(errorMsg, 502, "AI_PROVIDER_ERROR");
              }

              const deltaContent = parsed.choices?.[0]?.delta?.content;
              const usage = parsed.usage
                ? {
                    inputTokens: parsed.usage.prompt_tokens ?? 0,
                    outputTokens: parsed.usage.completion_tokens ?? 0,
                    totalTokens: parsed.usage.total_tokens ?? 0,
                  }
                : undefined;

              if (deltaContent) {
                yield {
                  content: deltaContent,
                  model: parsed.model || targetModel,
                  usage,
                };
              } else if (usage) {
                yield {
                  content: "",
                  model: parsed.model || targetModel,
                  usage,
                  done: true,
                };
              }
            } catch (jsonErr) {
              if (jsonErr instanceof AppError) throw jsonErr;
              // Ignore partial JSON parse errors for intermediate chunks
            }
          }
        }
      }

      if (buffer.trim()) {
        const remainingLines = buffer.split("\n");
        for (const rawLine of remainingLines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(":")) continue;

          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) {
                const errorMsg = parsed.error.message || "Groq API stream error";
                throw new AppError(errorMsg, 502, "AI_PROVIDER_ERROR");
              }

              const deltaContent = parsed.choices?.[0]?.delta?.content;
              const usage = parsed.usage
                ? {
                    inputTokens: parsed.usage.prompt_tokens ?? 0,
                    outputTokens: parsed.usage.completion_tokens ?? 0,
                    totalTokens: parsed.usage.total_tokens ?? 0,
                  }
                : undefined;

              if (deltaContent) {
                yield {
                  content: deltaContent,
                  model: parsed.model || targetModel,
                  usage,
                };
              } else if (usage) {
                yield {
                  content: "",
                  model: parsed.model || targetModel,
                  usage,
                  done: true,
                };
              }
            } catch (jsonErr) {
              if (jsonErr instanceof AppError) throw jsonErr;
            }
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
        streamError instanceof Error ? streamError.message : "Failed during AI stream reading",
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
