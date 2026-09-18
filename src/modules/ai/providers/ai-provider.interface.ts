export type AIMessageRole = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AIMessage = {
  role: AIMessageRole;
  content: string;
  toolCallId?: string | undefined;
  toolCalls?: ToolCall[] | undefined;
  name?: string | undefined;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AIResponse = {
  content: string;
  provider: string;
  model: string;
  usage: AIUsage;
  toolCalls?: ToolCall[] | undefined;
};

export interface AIStreamChunk {
  content?: string | undefined;
  model?: string | undefined;
  usage?: AIUsage | undefined;
  done?: boolean | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResponseOptions {
  model?: string | undefined;
  maxTokens?: number | undefined;
  tools?: ToolDefinition[] | undefined;
}

export interface AIProvider {
  readonly name: string;
  generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions | undefined,
  ): Promise<AIResponse>;
  generateChatStream?(
    messages: AIMessage[],
    options?: ChatResponseOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<AIStreamChunk>;
}
