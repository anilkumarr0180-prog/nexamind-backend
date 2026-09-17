export type AIMessageRole = "user" | "assistant" | "system";

export type AIMessage = {
  role: AIMessageRole;
  content: string;
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
};

export interface AIProvider {
  readonly name: string;
  generateChatResponse(
    messages: AIMessage[],
    options?: { model?: string; maxTokens?: number },
  ): Promise<AIResponse>;
}
