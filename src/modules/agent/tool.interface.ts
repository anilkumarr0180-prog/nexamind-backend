import type { ToolCallResult } from "./agent.types.js";

/**
 * JSON Schema definition for tool input parameters.
 */
export interface ToolInputSchema {
  type: "object" | string;
  properties?: Record<string, unknown> | undefined;
  required?: string[] | undefined;
  description?: string | undefined;
  additionalProperties?: boolean | undefined;
  [key: string]: unknown;
}

/**
 * Contextual metadata provided to an agent tool during execution.
 */
export interface ToolExecutionContext {
  toolCallId?: string | undefined;
  userId?: string | undefined;
  conversationId?: string | undefined;
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Outcome of executing an individual tool, compatible with ToolCallResult.
 */
export interface ToolExecutionResult<TOutput = unknown> {
  output: TOutput;
  isError?: boolean | undefined;
  error?: string | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  durationMs?: number | undefined;
}

/**
 * Declarative definition of an agent tool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: ToolInputSchema;
  parameters?: ToolInputSchema | undefined;
}

/**
 * Executable agent tool contract.
 */
export interface AgentTool<TInput = Record<string, unknown>, TOutput = unknown>
  extends ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: ToolInputSchema;
  readonly parameters?: ToolInputSchema | undefined;
  execute(
    input: TInput,
    context?: ToolExecutionContext | undefined,
  ): Promise<ToolExecutionResult<TOutput>>;
}

/**
 * Alias for AgentTool.
 */
export type Tool<TInput = Record<string, unknown>, TOutput = unknown> =
  AgentTool<TInput, TOutput>;
