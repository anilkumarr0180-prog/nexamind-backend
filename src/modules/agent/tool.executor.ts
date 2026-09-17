import type { ToolCall, ToolCallResult } from "./agent.types.js";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./tool.interface.js";
import {
  ToolRegistry,
  toolRegistry as defaultToolRegistry,
} from "./tool.registry.js";

/**
 * Options for initializing a ToolExecutor.
 */
export interface ToolExecutorOptions {
  registry?: ToolRegistry | undefined;
}

/**
 * Executes agent tool calls safely, resolving tools through a ToolRegistry,
 * measuring execution duration, and normalizing results into ToolCallResult without throwing.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry = defaultToolRegistry) {
    this.registry = registry;
  }

  /**
   * Executes a tool call and produces a normalized ToolCallResult.
   * Never throws raw tool execution errors to the caller.
   */
  public async execute(
    toolCall: ToolCall,
    context?: ToolExecutionContext | undefined,
  ): Promise<ToolCallResult> {
    const startTime = Date.now();

    const toolCallId = toolCall?.id || "unknown";
    const toolName = toolCall?.name?.trim() || "unknown";

    if (!toolCall || typeof toolCall !== "object" || !toolCall.name?.trim()) {
      return {
        toolCallId,
        toolName,
        output: null,
        isError: true,
        error: "Invalid tool call: tool name is required",
        durationMs: 0,
      };
    }

    const tool: AgentTool | undefined = this.registry.get(toolName);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      return {
        toolCallId,
        toolName,
        output: null,
        isError: true,
        error: `Tool "${toolName}" is not registered`,
        durationMs,
      };
    }

    if (context?.signal?.aborted) {
      return {
        toolCallId,
        toolName,
        output: null,
        isError: true,
        error: "Tool execution cancelled",
        durationMs: Math.max(0, Date.now() - startTime),
      };
    }

    const executionContext: ToolExecutionContext = {
      ...context,
      toolCallId,
    };

    const args = toolCall.arguments ?? {};

    try {
      const rawResult = await tool.execute(args, executionContext);
      const measuredDurationMs = Math.max(0, Date.now() - startTime);

      return this.normalizeResult(
        toolCallId,
        toolName,
        rawResult,
        measuredDurationMs,
      );
    } catch (error: unknown) {
      const measuredDurationMs = Math.max(0, Date.now() - startTime);
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Tool execution encountered an unexpected error";

      return {
        toolCallId,
        toolName,
        output: null,
        isError: true,
        error: errorMessage || "Tool execution failed",
        durationMs: measuredDurationMs,
      };
    }
  }

  /**
   * Normalizes any tool execution output into a consistent ToolCallResult.
   */
  private normalizeResult(
    toolCallId: string,
    toolName: string,
    rawResult: unknown,
    measuredDurationMs: number,
  ): ToolCallResult {
    if (
      typeof rawResult === "object" &&
      rawResult !== null &&
      "output" in rawResult
    ) {
      const resultObj = rawResult as ToolExecutionResult;
      const isError = Boolean(resultObj.isError);

      return {
        toolCallId,
        toolName,
        output: resultObj.output ?? null,
        isError,
        ...(resultObj.error
          ? { error: resultObj.error }
          : isError
            ? { error: "Tool execution indicated failure" }
            : {}),
        durationMs:
          typeof resultObj.durationMs === "number" && resultObj.durationMs >= 0
            ? resultObj.durationMs
            : measuredDurationMs,
      };
    }

    return {
      toolCallId,
      toolName,
      output: rawResult ?? null,
      isError: false,
      durationMs: measuredDurationMs,
    };
  }
}

/**
 * Default global singleton instance of ToolExecutor.
 */
export const toolExecutor = new ToolExecutor(defaultToolRegistry);

/**
 * Convenience helper function to execute a tool call using the default or custom ToolRegistry.
 */
export const executeToolCall = async (
  toolCall: ToolCall,
  context?: ToolExecutionContext | undefined,
  registry: ToolRegistry = defaultToolRegistry,
): Promise<ToolCallResult> => {
  const executor =
    registry === defaultToolRegistry ? toolExecutor : new ToolExecutor(registry);
  return executor.execute(toolCall, context);
};
