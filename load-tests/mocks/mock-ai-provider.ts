import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../../src/modules/ai/providers/ai-provider.interface.js";

export class MockLoadTestAIProvider implements AIProvider {
  public readonly name = "mock-loadtest";
  public callCount = 0;
  public chunkDelayMs: number;
  public toolDelayMs: number;
  public simulateAgentToolStep: boolean;

  constructor(options?: {
    chunkDelayMs?: number;
    toolDelayMs?: number;
    simulateAgentToolStep?: boolean;
  }) {
    this.chunkDelayMs = options?.chunkDelayMs ?? 10;
    this.toolDelayMs = options?.toolDelayMs ?? 15;
    this.simulateAgentToolStep = options?.simulateAgentToolStep ?? false;
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    this.callCount++;

    // If agent tools are provided and simulateAgentToolStep is active on first turn
    const hasTools = options?.tools && options.tools.length > 0;
    const hasToolResult = messages.some((m) => m.role === "tool");

    if (this.simulateAgentToolStep && hasTools && !hasToolResult) {
      if (this.toolDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.toolDelayMs));
      }
      return {
        content: "Calculating expression...",
        provider: this.name,
        model: "mock-loadtest-model",
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
        toolCalls: [
          {
            id: `call_${Date.now()}`,
            name: "calculator",
            arguments: { expression: "25 * 40" },
          },
        ],
      };
    }

    if (this.chunkDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.chunkDelayMs * 2));
    }

    return {
      content: "This is a completed load test response synthesized by MockLoadTestAIProvider.",
      provider: this.name,
      model: "mock-loadtest-model",
      usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
    };
  }

  async *generateChatStream(
    _messages: AIMessage[],
    _options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.callCount++;

    const chunks = [
      "Here is ",
      "the streaming ",
      "response generated ",
      "during the ",
      "NexaMind high-concurrency ",
      "load testing scenario. ",
      "All tokens delivered cleanly.",
    ];

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) return;

      if (this.chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
      }

      if (signal?.aborted) return;

      const isLast = i === chunks.length - 1;
      yield {
        content: chunks[i]!,
        model: "mock-loadtest-model",
        ...(isLast
          ? {
              usage: { inputTokens: 50, outputTokens: 35, totalTokens: 85 },
              done: true,
            }
          : {}),
      };
    }
  }
}
