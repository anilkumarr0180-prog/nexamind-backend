import { randomUUID } from "node:crypto";
import type {
  AIMessage,
  AIProvider,
  AIResponse,
  ChatResponseOptions,
  ToolDefinition as AIToolDefinition,
} from "../ai/providers/ai-provider.interface.js";
import { getDefaultProvider } from "../ai/orchestrator.service.js";
import {
  AGENT_STATUSES,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentExecutionState,
  type AgentRunOptions,
  TOOL_CALL_STATUSES,
  type ToolCallInfo,
} from "./agent.types.js";
import {
  ToolRegistry,
  toolRegistry as defaultToolRegistry,
} from "./tool.registry.js";
import {
  ToolExecutor,
  toolExecutor as defaultToolExecutor,
} from "./tool.executor.js";

/**
 * Configuration options for initializing an AgentLoop instance.
 */
export interface AgentLoopOptions {
  provider?: AIProvider | undefined;
  registry?: ToolRegistry | undefined;
  executor?: ToolExecutor | undefined;
}

/**
 * Autonomous agent execution loop.
 *
 * Coordinates execution between the configured AI provider, ToolRegistry,
 * and ToolExecutor until a final completion or safe termination condition is met.
 */
export class AgentLoop {
  private customProvider?: AIProvider | undefined;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;

  constructor(options?: AgentLoopOptions) {
    this.registry = options?.registry ?? defaultToolRegistry;
    this.executor =
      options?.executor ??
      (options?.registry ? new ToolExecutor(this.registry) : defaultToolExecutor);
    this.customProvider = options?.provider;
  }

  private get provider(): AIProvider {
    return this.customProvider ?? getDefaultProvider();
  }

  /**
   * Executes an autonomous agent run based on the provided input.
   */
  public async run(
    input: AgentExecutionInput,
    runOptions?: AgentRunOptions,
  ): Promise<AgentExecutionResult> {
    const executionId = `exec_${randomUUID()}`;
    const startTime = Date.now();
    const callbacks = runOptions?.callbacks;
    const signal = runOptions?.signal;

    // Strict validation of input parameters
    if (!input || typeof input !== "object" || !input.task?.trim() || !input.userId?.trim()) {
      const now = new Date();
      return {
        executionId,
        userId: input?.userId ?? "unknown",
        task: input?.task ?? "",
        status: AGENT_STATUSES.FAILED,
        output: null,
        stepsCompleted: 0,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        startedAt: new Date(startTime),
        completedAt: now,
        durationMs: Math.max(0, now.getTime() - startTime),
        conversationId: input?.conversationId,
        error: "Invalid agent execution input: userId and task are required",
        metadata: input?.metadata,
      };
    }

    const startedAt = new Date(startTime);
    const maxSteps =
      typeof input.maxSteps === "number" && input.maxSteps > 0
        ? Math.floor(input.maxSteps)
        : 10;

    // Step 2: Initialize execution state with RUNNING status
    const state: AgentExecutionState = {
      id: executionId,
      userId: input.userId.trim(),
      task: input.task.trim(),
      status: AGENT_STATUSES.RUNNING,
      currentStep: 0,
      maxSteps,
      messages: [],
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      conversationId: input.conversationId,
      startedAt,
      updatedAt: startedAt,
      metadata: input.metadata,
    };

    // Emit safe initial lifecycle events
    callbacks?.onStart?.({
      conversationId: state.conversationId,
    });
    callbacks?.onStatus?.("started", "Working...");

    // Immediate cancellation check
    if (signal?.aborted) {
      const completedAt = new Date();
      state.status = AGENT_STATUSES.CANCELLED;
      state.completedAt = completedAt;
      state.updatedAt = completedAt;
      return {
        executionId: state.id,
        userId: state.userId,
        task: state.task,
        status: AGENT_STATUSES.CANCELLED,
        output: null,
        stepsCompleted: 0,
        toolCalls: [],
        usage: state.usage,
        startedAt: state.startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startTime),
        conversationId: state.conversationId,
        metadata: state.metadata,
      };
    }

    // Prepare initial conversation messages
    if (input.systemPrompt?.trim()) {
      state.messages.push({
        role: "system",
        content: input.systemPrompt.trim(),
      });
    }

    if (input.initialMessages && input.initialMessages.length > 0) {
      if (input.context && Object.keys(input.context).length > 0) {
        const lastIdx = input.initialMessages.length - 1;
        const mapped = input.initialMessages.map((m, idx) => {
          if (idx === lastIdx && m.role === "user") {
            return {
              ...m,
              content: `Context:\n${JSON.stringify(input.context, null, 2)}\n\n${m.content}`,
            };
          }
          return m;
        });
        state.messages.push(...mapped);
      } else {
        state.messages.push(...input.initialMessages);
      }
    } else {
      let userContent = input.task.trim();
      if (input.context && Object.keys(input.context).length > 0) {
        userContent = `Context:\n${JSON.stringify(input.context, null, 2)}\n\nTask:\n${userContent}`;
      }

      state.messages.push({
        role: "user",
        content: userContent,
      });
    }

    // Step 3: Loop while currentStep < maxSteps
    while (state.currentStep < state.maxSteps) {
      if (signal?.aborted) {
        const completedAt = new Date();
        state.status = AGENT_STATUSES.CANCELLED;
        state.completedAt = completedAt;
        state.updatedAt = completedAt;
        return {
          executionId: state.id,
          userId: state.userId,
          task: state.task,
          status: AGENT_STATUSES.CANCELLED,
          output: state.output ?? null,
          stepsCompleted: state.currentStep,
          toolCalls: state.toolCalls,
          usage: state.usage,
          startedAt: state.startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - startTime),
          conversationId: state.conversationId,
          metadata: state.metadata,
        };
      }

      const toolDefinitions = this.getToolDefinitions();
      const chatOptions: ChatResponseOptions = {
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      };

      let response: AIResponse;
      try {
        response = await this.provider.generateChatResponse(
          state.messages,
          chatOptions,
        );
      } catch (error: unknown) {
        if (signal?.aborted) {
          const completedAt = new Date();
          state.status = AGENT_STATUSES.CANCELLED;
          state.completedAt = completedAt;
          state.updatedAt = completedAt;
          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.CANCELLED,
            output: state.output ?? null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            usage: state.usage,
            startedAt: state.startedAt,
            completedAt,
            durationMs: Math.max(0, completedAt.getTime() - startTime),
            conversationId: state.conversationId,
            metadata: state.metadata,
          };
        }

        // Return FAILED for unrecoverable provider/execution errors
        const completedAt = new Date();
        const durationMs = Math.max(0, completedAt.getTime() - state.startedAt.getTime());
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Provider encountered an unrecoverable error";

        state.status = AGENT_STATUSES.FAILED;
        state.error = errorMessage;
        state.completedAt = completedAt;
        state.updatedAt = completedAt;

        callbacks?.onError?.(error);

        return {
          executionId: state.id,
          userId: state.userId,
          task: state.task,
          status: AGENT_STATUSES.FAILED,
          output: null,
          stepsCompleted: state.currentStep,
          toolCalls: state.toolCalls,
          usage: state.usage,
          startedAt: state.startedAt,
          completedAt,
          durationMs,
          conversationId: state.conversationId,
          error: errorMessage,
          metadata: state.metadata,
        };
      }

      // Step 8: Track token usage
      if (response.usage) {
        state.usage.inputTokens += response.usage.inputTokens || 0;
        state.usage.outputTokens += response.usage.outputTokens || 0;
        state.usage.totalTokens += response.usage.totalTokens || 0;
      }

      const hasToolCalls =
        Array.isArray(response.toolCalls) && response.toolCalls.length > 0;

      // Step 4: If the model returns tool calls
      if (hasToolCalls && response.toolCalls) {
        // Record assistant response with requested tool calls
        state.messages.push({
          role: "assistant",
          content: response.content || "",
          toolCalls: response.toolCalls,
        });

        // Execute each requested tool through ToolExecutor
        for (const toolCall of response.toolCalls) {
          if (signal?.aborted) {
            break;
          }

          const toolCallStartedAt = new Date();
          const toolCallInfo: ToolCallInfo = {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments ?? {},
            status: TOOL_CALL_STATUSES.EXECUTING,
            startedAt: toolCallStartedAt,
          };

          // Safe execution status event: tool running
          callbacks?.onToolStatus?.({
            status: "running",
            tool: toolCall.name,
            toolCallId: toolCall.id,
          });

          const toolResult = await this.executor.execute(toolCall, {
            toolCallId: toolCall.id,
            userId: state.userId,
            conversationId: state.conversationId,
            signal,
          });

          const toolCallCompletedAt = new Date();
          toolCallInfo.completedAt = toolCallCompletedAt;
          toolCallInfo.durationMs =
            typeof toolResult.durationMs === "number" && toolResult.durationMs >= 0
              ? toolResult.durationMs
              : Math.max(0, toolCallCompletedAt.getTime() - toolCallStartedAt.getTime());

          if (toolResult.isError) {
            toolCallInfo.status = TOOL_CALL_STATUSES.ERROR;
            toolCallInfo.error = toolResult.error ?? "Tool execution failed";
            toolCallInfo.result = toolResult.output;

            // Safe execution status event: tool failed
            callbacks?.onToolStatus?.({
              status: "failed",
              tool: toolCall.name,
              toolCallId: toolCall.id,
              error: toolCallInfo.error,
              durationMs: toolCallInfo.durationMs,
            });
          } else {
            toolCallInfo.status = TOOL_CALL_STATUSES.SUCCESS;
            toolCallInfo.result = toolResult.output;

            // Safe execution status event: tool completed
            callbacks?.onToolStatus?.({
              status: "completed",
              tool: toolCall.name,
              toolCallId: toolCall.id,
              durationMs: toolCallInfo.durationMs,
            });
          }

          state.toolCalls.push(toolCallInfo);

          // Append tool result message to conversation
          let contentStr: string;
          if (toolResult.isError) {
            contentStr = toolResult.error
              ? (typeof toolResult.error === "string" ? toolResult.error : JSON.stringify(toolResult.error))
              : JSON.stringify(toolResult.output ?? { error: "Tool execution failed" });
          } else if (typeof toolResult.output === "string") {
            contentStr = toolResult.output;
          } else {
            contentStr = JSON.stringify(toolResult.output ?? null);
          }

          state.messages.push({
            role: "tool",
            content: contentStr,
            toolCallId: toolCall.id,
            name: toolCall.name,
          });
        }

        if (signal?.aborted) {
          const completedAt = new Date();
          state.status = AGENT_STATUSES.CANCELLED;
          state.completedAt = completedAt;
          state.updatedAt = completedAt;
          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.CANCELLED,
            output: state.output ?? null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            usage: state.usage,
            startedAt: state.startedAt,
            completedAt,
            durationMs: Math.max(0, completedAt.getTime() - startTime),
            conversationId: state.conversationId,
            metadata: state.metadata,
          };
        }

        state.currentStep += 1;
        state.updatedAt = new Date();

        // Step 6: Stop when maxSteps is reached
        if (state.currentStep >= state.maxSteps) {
          const completedAt = new Date();
          const durationMs = Math.max(0, completedAt.getTime() - state.startedAt.getTime());
          const maxStepsError = `Maximum execution steps (${state.maxSteps}) reached`;

          state.status = AGENT_STATUSES.FAILED;
          state.error = maxStepsError;
          state.completedAt = completedAt;
          state.updatedAt = completedAt;

          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.FAILED,
            output: null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            usage: state.usage,
            startedAt: state.startedAt,
            completedAt,
            durationMs,
            conversationId: state.conversationId,
            error: maxStepsError,
            metadata: state.metadata,
          };
        }

        // Continue the loop
        continue;
      }

      // Step 5: Model returned normal content (no tool calls) -> Final response generation
      callbacks?.onStatus?.("generating", "Generating response...");

      // If progressive streaming requested and provider supports streaming:
      if (callbacks?.onChunk && typeof this.provider.generateChatStream === "function") {
        let streamedContent = "";
        try {
          for await (const chunk of this.provider.generateChatStream(
            state.messages,
            chatOptions,
            signal,
          )) {
            if (signal?.aborted) {
              break;
            }
            if (chunk.content) {
              streamedContent += chunk.content;
              callbacks.onChunk(chunk.content);
            }
            if (chunk.usage) {
              state.usage.inputTokens += chunk.usage.inputTokens || 0;
              state.usage.outputTokens += chunk.usage.outputTokens || 0;
              state.usage.totalTokens += chunk.usage.totalTokens || 0;
            }
          }
        } catch (streamError: unknown) {
          if (signal?.aborted) {
            // Aborted cleanly during stream
          } else {
            if (!streamedContent && response.content) {
              streamedContent = response.content;
              callbacks.onChunk(streamedContent);
            } else {
              throw streamError;
            }
          }
        }

        if (signal?.aborted) {
          const completedAt = new Date();
          state.status = AGENT_STATUSES.CANCELLED;
          state.output = streamedContent.trim() ? streamedContent : undefined;
          state.completedAt = completedAt;
          state.updatedAt = completedAt;
          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.CANCELLED,
            output: state.output ?? null,
            stepsCompleted: state.currentStep + 1,
            toolCalls: state.toolCalls,
            usage: state.usage,
            startedAt: state.startedAt,
            completedAt,
            durationMs: Math.max(0, completedAt.getTime() - startTime),
            conversationId: state.conversationId,
            metadata: state.metadata,
          };
        }

        state.output = streamedContent || response.content;
      } else {
        state.output = response.content;
        if (callbacks?.onChunk && response.content) {
          callbacks.onChunk(response.content);
        }
      }

      state.currentStep += 1;
      state.status = AGENT_STATUSES.COMPLETED;

      const completedAt = new Date();
      state.completedAt = completedAt;
      state.updatedAt = completedAt;

      state.messages.push({
        role: "assistant",
        content: state.output || "",
      });

      const durationMs = Math.max(0, completedAt.getTime() - state.startedAt.getTime());

      const finalResult: AgentExecutionResult = {
        executionId: state.id,
        userId: state.userId,
        task: state.task,
        status: AGENT_STATUSES.COMPLETED,
        output: state.output,
        stepsCompleted: state.currentStep,
        toolCalls: state.toolCalls,
        usage: state.usage,
        startedAt: state.startedAt,
        completedAt,
        durationMs,
        conversationId: state.conversationId,
        metadata: state.metadata,
      };

      callbacks?.onDone?.(finalResult);
      return finalResult;
    }

    // Safeguard fallback if loop terminates unexpectedly without completing
    const completedAt = new Date();
    const durationMs = Math.max(0, completedAt.getTime() - state.startedAt.getTime());
    const fallbackError = `Maximum execution steps (${state.maxSteps}) reached`;

    return {
      executionId: state.id,
      userId: state.userId,
      task: state.task,
      status: AGENT_STATUSES.FAILED,
      output: null,
      stepsCompleted: state.currentStep,
      toolCalls: state.toolCalls,
      usage: state.usage,
      startedAt: state.startedAt,
      completedAt,
      durationMs,
      conversationId: state.conversationId,
      error: fallbackError,
      metadata: state.metadata,
    };
  }

  /**
   * Retrieves tool definitions from the registry mapped to provider format.
   */
  private getToolDefinitions(): AIToolDefinition[] {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool.parameters ??
        tool.schema ?? {
          type: "object",
          properties: {},
        }) as Record<string, unknown>,
    }));
  }
}

/**
 * Default global singleton instance of AgentLoop.
 */
export const agentLoop = new AgentLoop();

/**
 * Convenience helper function to run an agent loop.
 */
export const runAgentLoop = async (
  input: AgentExecutionInput,
  options?: AgentLoopOptions | AgentRunOptions,
  runOptions?: AgentRunOptions,
): Promise<AgentExecutionResult> => {
  let loopOptions: AgentLoopOptions | undefined;
  let executionRunOptions: AgentRunOptions | undefined = runOptions;

  if (options && ("callbacks" in options || "signal" in options)) {
    executionRunOptions = options as AgentRunOptions;
  } else if (options) {
    loopOptions = options as AgentLoopOptions;
  }

  const runner = loopOptions ? new AgentLoop(loopOptions) : agentLoop;
  return runner.run(input, executionRunOptions);
};

/**
 * Alias for runAgentLoop.
 */
export const executeAgent = runAgentLoop;
