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
  type AgentPlan,
  type PlanStep,
  type AgentRunOptions,
  type AgentTraceStep,
  TOOL_CALL_STATUSES,
  type ToolCallInfo,
  type ToolCallResult,
} from "./agent.types.js";
import {
  ToolRegistry,
  toolRegistry as defaultToolRegistry,
} from "./tool.registry.js";
import { ToolExecutor, toolExecutor as defaultToolExecutor } from "./tool.executor.js";
import { isValidWebUrl } from "./tools/web-search.tool.js";
import { WEB_SEARCH_CITATION_INSTRUCTIONS } from "../ai/prompts/system.prompt.js";

/**
 * Maximum number of web_search tool executions permitted per AI/Agent request.
 * Prevents runaway agent loops and unbounded external Tavily search requests.
 */
export const MAX_WEB_SEARCHES_PER_REQUEST = 2;

/**
 * Maximum times a tool call with the exact same name and arguments can fail
 * before repeated calls are blocked to prevent infinite loops.
 */
export const MAX_REPEATED_TOOL_FAILURES = 2;

/**
 * Maximum consecutive failed tool steps permitted before prompting the model
 * to synthesize a final answer using available knowledge.
 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

/**
 * Normalizes tool arguments into a stable deterministic key for failure tracking.
 */
export function getToolCallKey(toolName: string, args: Record<string, unknown>): string {
  try {
    const keys = Object.keys(args || {}).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of keys) {
      sortedObj[k] = args[k];
    }
    return `${toolName.toLowerCase().trim()}:${JSON.stringify(sortedObj)}`;
  } catch {
    return `${toolName.toLowerCase().trim()}:${JSON.stringify(args || {})}`;
  }
}

/**
 * Normalizes a web search query for exact deduplication within an agent request.
 * Trims surrounding whitespace, collapses internal whitespace, and converts to lowercase.
 */
export function normalizeWebSearchQuery(query: unknown): string {
  if (typeof query !== "string") {
    return "";
  }
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Formats a user-safe concise title for a tool execution step.
 */
export function formatToolStepTitle(toolName: string): string {
  switch (toolName.toLowerCase().trim()) {
    case "web_search":
      return "Search current information";
    case "calculator":
      return "Calculate the result";
    case "unit_conversion":
      return "Convert measurement units";
    case "datetime":
      return "Check date and time";
    default:
      return `Execute ${toolName}`;
  }
}

/**
 * Builds an initial plan / intent sequence from task intent and registered tools
 * during the first turn without requiring an extra LLM call.
 */
export function buildInitialPlan(task: string, registry: ToolRegistry): AgentPlan {
  const steps: PlanStep[] = [];
  let stepCounter = 1;

  const checkOrder = ["web_search", "unit_conversion", "calculator", "datetime"];
  for (const name of checkOrder) {
    const tool = registry.get(name);
    if (tool && typeof tool.matchesQuery === "function" && tool.matchesQuery(task)) {
      steps.push({
        id: `plan-step-${stepCounter++}`,
        title: formatToolStepTitle(name),
        status: "pending",
        tool: name,
      });
    }
  }

  if (steps.length === 0) {
    steps.push({
      id: `plan-step-${stepCounter++}`,
      title: "Analyze request and determine steps",
      status: "pending",
    });
  }

  steps.push({
    id: `plan-step-${stepCounter++}`,
    title: "Generate the answer",
    status: "pending",
  });

  return { steps };
}

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
        trace: [],
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
    const initialPlan = buildInitialPlan(input.task.trim(), this.registry);
    const state: AgentExecutionState = {
      id: executionId,
      userId: input.userId.trim(),
      task: input.task.trim(),
      status: AGENT_STATUSES.RUNNING,
      currentStep: 0,
      maxSteps,
      messages: [],
      toolCalls: [],
      trace: [],
      sources: [],
      plan: initialPlan,
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

    // Track fresh external web_search executions during this request
    let freshWebSearchesCount = 0;

    // Track tool failure occurrences to prevent infinite retry loops
    const failedToolCallCounts = new Map<string, number>();
    let consecutiveFailedSteps = 0;

    // Emit safe initial lifecycle events
    callbacks?.onStart?.({
      conversationId: state.conversationId,
    });
    callbacks?.onStatus?.("started", "Working...");
    if (state.plan) {
      callbacks?.onPlan?.(state.plan);
    }

    // Immediate cancellation check
    if (signal?.aborted) {
      const completedAt = new Date();
      state.status = AGENT_STATUSES.CANCELLED;
      state.completedAt = completedAt;
      state.updatedAt = completedAt;
      if (state.plan) {
        state.plan.steps.forEach((s) => {
          if (s.status === "pending" || s.status === "running") {
            s.status = "skipped";
          }
        });
        callbacks?.onPlan?.(state.plan);
      }
      return {
        executionId: state.id,
        userId: state.userId,
        task: state.task,
        status: AGENT_STATUSES.CANCELLED,
        output: null,
        stepsCompleted: 0,
        toolCalls: [],
        trace: state.trace,
        sources: state.sources,
        plan: state.plan,
        usage: state.usage,
        startedAt: state.startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startTime),
        conversationId: state.conversationId,
        metadata: state.metadata,
      };
    }

    // Prepare initial conversation messages
    const rawInitialMessages = input.initialMessages || [];
    const nonSystemInitialMessages = rawInitialMessages.filter(
      (m) => m.role !== "system",
    );
    const existingSystemContent = rawInitialMessages
      .filter((m) => m.role === "system")
      .map((m) => m.content?.trim())
      .filter(Boolean)
      .join("\n\n");

    const explicitSystem = input.systemPrompt?.trim();
    const systemPromptParts: string[] = [];

    if (explicitSystem) {
      systemPromptParts.push(explicitSystem);
    }

    if (
      existingSystemContent &&
      !systemPromptParts.some((p) => p.includes(existingSystemContent))
    ) {
      systemPromptParts.push(existingSystemContent);
    }

    if (systemPromptParts.length > 0) {
      state.messages.push({
        role: "system",
        content: systemPromptParts.join("\n\n"),
      });
    }

    if (nonSystemInitialMessages.length > 0) {
      if (input.context && Object.keys(input.context).length > 0) {
        const lastIdx = nonSystemInitialMessages.length - 1;
        const mapped = nonSystemInitialMessages.map((m, idx) => {
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
        state.messages.push(...nonSystemInitialMessages);
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
        if (state.plan) {
          state.plan.steps.forEach((s) => {
            if (s.status === "pending" || s.status === "running") {
              s.status = "skipped";
            }
          });
          callbacks?.onPlan?.(state.plan);
        }
        return {
          executionId: state.id,
          userId: state.userId,
          task: state.task,
          status: AGENT_STATUSES.CANCELLED,
          output: state.output ?? null,
          stepsCompleted: state.currentStep,
          toolCalls: state.toolCalls,
          trace: state.trace,
          sources: state.sources,
          plan: state.plan,
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
          if (state.plan) {
            state.plan.steps.forEach((s) => {
              if (s.status === "pending" || s.status === "running") {
                s.status = "skipped";
              }
            });
            callbacks?.onPlan?.(state.plan);
          }
          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.CANCELLED,
            output: state.output ?? null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            trace: state.trace,
            sources: state.sources,
            plan: state.plan,
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

        if (state.plan) {
          state.plan.steps.forEach((s) => {
            if (s.status === "running") {
              s.status = "failed";
              s.error = errorMessage;
            } else if (s.status === "pending") {
              s.status = "skipped";
            }
          });
          callbacks?.onPlan?.(state.plan);
        }

        const errorTrace: AgentTraceStep = {
          step: state.currentStep + 1,
          type: "error",
          error: errorMessage,
          status: "failed",
          durationMs,
          timestamp: completedAt.toISOString(),
        };
        state.trace.push(errorTrace);
        callbacks?.onTrace?.(errorTrace);
        callbacks?.onError?.(error);

        return {
          executionId: state.id,
          userId: state.userId,
          task: state.task,
          status: AGENT_STATUSES.FAILED,
          output: null,
          stepsCompleted: state.currentStep,
          toolCalls: state.toolCalls,
          trace: state.trace,
          sources: state.sources,
          plan: state.plan,
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

        let anyToolSucceededInStep = false;

        // Execute each requested tool through ToolExecutor
        for (const toolCall of response.toolCalls) {
          if (signal?.aborted) {
            break;
          }

          // Advance plan step status for this tool to running
          if (state.plan) {
            let step = state.plan.steps.find(
              (s) => s.tool === toolCall.name && s.status === "pending"
            );
            if (!step) {
              // Replace generic placeholder step (e.g. "Analyze request..."), never the final answer step
              step = state.plan.steps.find(
                (s, idx) => s.status === "pending" && !s.tool && idx < (state.plan?.steps.length ?? 0) - 1
              );
              if (step) {
                step.tool = toolCall.name;
                step.title = formatToolStepTitle(toolCall.name);
              }
            }
            if (!step) {
              step = {
                id: `plan-step-${state.plan.steps.length + 1}`,
                title: formatToolStepTitle(toolCall.name),
                status: "running",
                tool: toolCall.name,
              };
              const insertIdx = Math.max(0, state.plan.steps.length - 1);
              state.plan.steps.splice(insertIdx, 0, step);
            } else {
              step.status = "running";
            }
            callbacks?.onPlan?.(state.plan);
          }

          const toolCallStartedAt = new Date();
          const toolCallInfo: ToolCallInfo = {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments ?? {},
            status: TOOL_CALL_STATUSES.EXECUTING,
            startedAt: toolCallStartedAt,
          };

          // Record and emit start trace
          const startTrace: AgentTraceStep = {
            step: state.currentStep + 1,
            type: "tool_call",
            tool: toolCall.name,
            toolCallId: toolCall.id,
            input: toolCall.arguments ?? {},
            status: "running",
            timestamp: toolCallStartedAt.toISOString(),
          };
          state.trace.push(startTrace);
          callbacks?.onTrace?.(startTrace);

          // Safe execution status event: tool running
          callbacks?.onToolStatus?.({
            status: "running",
            tool: toolCall.name,
            toolCallId: toolCall.id,
          });

          // Check for repeated tool failure protection
          const toolCallKey = getToolCallKey(toolCall.name, toolCall.arguments ?? {});
          const previousFailures = failedToolCallCounts.get(toolCallKey) ?? 0;

          let toolResult: ToolCallResult;

          if (previousFailures >= MAX_REPEATED_TOOL_FAILURES) {
            // Intercept repeated failing tool call without re-executing
            toolResult = {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              output: `Repeated tool failure detected: "${toolCall.name}" previously failed with identical arguments. Do NOT retry this tool with the same arguments. Please synthesize an answer from available knowledge or explain what could not be completed.`,
              isError: true,
              error: `Tool "${toolCall.name}" previously failed with identical arguments`,
              durationMs: 0,
            };
          } else if (toolCall.name === "web_search") {
            const rawQuery =
              typeof toolCall.arguments?.query === "string"
                ? toolCall.arguments.query
                : "";
            const normalizedQuery = normalizeWebSearchQuery(rawQuery);

            // Check if the same normalized query was already successfully executed during this request
            const cachedCall = state.toolCalls.find((tc) => {
              if (
                tc.name !== "web_search" ||
                tc.status !== TOOL_CALL_STATUSES.SUCCESS ||
                !tc.result ||
                typeof tc.result !== "object"
              ) {
                return false;
              }
              const prevRaw =
                typeof tc.arguments?.query === "string"
                  ? tc.arguments.query
                  : "";
              return normalizeWebSearchQuery(prevRaw) === normalizedQuery;
            });

            if (cachedCall) {
              // Reuse previous Web Search result without calling Tavily again
              toolResult = {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                output: cachedCall.result,
                isError: false,
                durationMs: 0,
              };
            } else if (freshWebSearchesCount >= MAX_WEB_SEARCHES_PER_REQUEST) {
              toolResult = {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                output:
                  "Maximum web search limit reached for this turn. Use the search results already retrieved to answer the user.",
                isError: false,
                durationMs: 0,
              };
            } else {
              freshWebSearchesCount++;
              toolResult = await this.executor.execute(toolCall, {
                toolCallId: toolCall.id,
                userId: state.userId,
                conversationId: state.conversationId,
                signal,
              });
            }
          } else {
            toolResult = await this.executor.execute(toolCall, {
              toolCallId: toolCall.id,
              userId: state.userId,
              conversationId: state.conversationId,
              signal,
            });
          }

          const toolCallCompletedAt = new Date();
          toolCallInfo.completedAt = toolCallCompletedAt;
          toolCallInfo.durationMs =
            typeof toolResult.durationMs === "number" && toolResult.durationMs >= 0
              ? toolResult.durationMs
              : Math.max(0, toolCallCompletedAt.getTime() - toolCallStartedAt.getTime());

          if (toolResult.isError) {
            failedToolCallCounts.set(toolCallKey, previousFailures + 1);
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

            // Update plan step to failed
            if (state.plan) {
              const step = state.plan.steps.find(
                (s) => s.tool === toolCall.name && s.status === "running"
              );
              if (step) {
                step.status = "failed";
                step.error = toolCallInfo.error;
                callbacks?.onPlan?.(state.plan);
              }
            }
          } else {
            anyToolSucceededInStep = true;
            toolCallInfo.status = TOOL_CALL_STATUSES.SUCCESS;
            toolCallInfo.result = toolResult.output;

            // Safe execution status event: tool completed
            callbacks?.onToolStatus?.({
              status: "completed",
              tool: toolCall.name,
              toolCallId: toolCall.id,
              durationMs: toolCallInfo.durationMs,
            });

            // Update plan step to completed
            if (state.plan) {
              const step = state.plan.steps.find(
                (s) => s.tool === toolCall.name && s.status === "running"
              );
              if (step) {
                step.status = "completed";
                callbacks?.onPlan?.(state.plan);
              }
            }

            if (
              toolCall.name === "web_search" &&
              toolResult.output &&
              typeof toolResult.output === "object"
            ) {
              const webOut = toolResult.output as any;
              if (Array.isArray(webOut.results)) {
                const seenUrls = new Set<string>();
                const webSources: Array<{ type: "web"; title: string; url: string }> = [];
                for (const r of webOut.results) {
                  if (r && isValidWebUrl(r.url)) {
                    const u = r.url.trim();
                    if (!seenUrls.has(u)) {
                      seenUrls.add(u);
                      webSources.push({
                        type: "web" as const,
                        title:
                          typeof r.title === "string" && r.title.trim()
                            ? r.title.trim()
                            : u,
                        url: u,
                      });
                    }
                  }
                }
                if (webSources.length > 0) {
                  state.sources = [...(state.sources || []), ...webSources];
                  callbacks?.onSources?.(webSources);
                }
              }

              // Augment system prompt with citation instructions if not already present
              if (state.messages.length > 0 && state.messages[0]?.role === "system") {
                if (!state.messages[0].content.includes("Web Search Citation Instructions")) {
                  state.messages[0].content = `${state.messages[0].content}\n\n${WEB_SEARCH_CITATION_INSTRUCTIONS}`.trim();
                }
              } else {
                state.messages.unshift({
                  role: "system",
                  content: WEB_SEARCH_CITATION_INSTRUCTIONS,
                });
              }
            }
          }

          // Record and emit completion trace
          const resultTrace: AgentTraceStep = {
            step: state.currentStep + 1,
            type: "tool_result",
            tool: toolCall.name,
            toolCallId: toolCall.id,
            output: toolResult.output,
            ...(toolResult.isError ? { error: toolCallInfo.error } : {}),
            status: toolResult.isError ? "failed" : "completed",
            durationMs: toolCallInfo.durationMs,
            timestamp: toolCallCompletedAt.toISOString(),
          };
          state.trace.push(resultTrace);
          callbacks?.onTrace?.(resultTrace);

          state.toolCalls.push(toolCallInfo);

          // Append tool result message to conversation
          let contentStr: string;
          if (toolResult.isError) {
            contentStr = toolResult.error
              ? (typeof toolResult.error === "string" ? toolResult.error : JSON.stringify(toolResult.error))
              : JSON.stringify(toolResult.output ?? { error: "Tool execution failed" });
          } else if (
            toolCall.name === "web_search" &&
            toolResult.output &&
            typeof toolResult.output === "object"
          ) {
            contentStr = formatWebSearchResultsForAI(toolResult.output);
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

        // Track consecutive failed steps
        if (anyToolSucceededInStep) {
          consecutiveFailedSteps = 0;
        } else {
          consecutiveFailedSteps++;
          if (consecutiveFailedSteps >= MAX_CONSECUTIVE_TOOL_FAILURES) {
            state.messages.push({
              role: "system",
              content:
                "Notice: Multiple consecutive tool calls have failed. Stop invoking tools and synthesize your best final response to the user based on available information.",
            });
          }
        }

        if (signal?.aborted) {
          const completedAt = new Date();
          state.status = AGENT_STATUSES.CANCELLED;
          state.completedAt = completedAt;
          state.updatedAt = completedAt;
          if (state.plan) {
            state.plan.steps.forEach((s) => {
              if (s.status === "pending" || s.status === "running") {
                s.status = "skipped";
              }
            });
            callbacks?.onPlan?.(state.plan);
          }
          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.CANCELLED,
            output: state.output ?? null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            trace: state.trace,
            sources: state.sources,
            plan: state.plan,
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

          if (state.plan) {
            state.plan.steps.forEach((s) => {
              if (s.status === "running") {
                s.status = "failed";
                s.error = maxStepsError;
              } else if (s.status === "pending") {
                s.status = "skipped";
              }
            });
            callbacks?.onPlan?.(state.plan);
          }

          return {
            executionId: state.id,
            userId: state.userId,
            task: state.task,
            status: AGENT_STATUSES.FAILED,
            output: null,
            stepsCompleted: state.currentStep,
            toolCalls: state.toolCalls,
            trace: state.trace,
            sources: state.sources,
            plan: state.plan,
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

      // Update final plan step to running
      if (state.plan) {
        const finalStep = state.plan.steps[state.plan.steps.length - 1];
        if (finalStep) {
          finalStep.status = "running";
          callbacks?.onPlan?.(state.plan);
        }
      }

      // Clean think tags if any exist in the response content
      let finalContent = response.content || "";
      if (finalContent.includes("</think>") || finalContent.startsWith("Thinking:")) {
        finalContent = finalContent
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/^Thinking:[\s\S]*?<\/think>/gi, "")
          .trim();
      }

      state.output = finalContent || response.content;
      if (callbacks?.onChunk && state.output) {
        callbacks.onChunk(state.output);
      }

      state.currentStep += 1;
      state.status = AGENT_STATUSES.COMPLETED;

      const completedAt = new Date();
      state.completedAt = completedAt;
      state.updatedAt = completedAt;

      // Update final plan step to completed
      if (state.plan) {
        const finalStep = state.plan.steps[state.plan.steps.length - 1];
        if (finalStep) {
          finalStep.status = "completed";
          callbacks?.onPlan?.(state.plan);
        }
      }

      state.messages.push({
        role: "assistant",
        content: state.output || "",
      });

      const durationMs = Math.max(0, completedAt.getTime() - state.startedAt.getTime());

      // Record final response trace step
      const finalTrace: AgentTraceStep = {
        step: state.currentStep,
        type: "final_response",
        output: state.output,
        status: "completed",
        durationMs,
        timestamp: completedAt.toISOString(),
      };
      state.trace.push(finalTrace);
      callbacks?.onTrace?.(finalTrace);

      const finalResult: AgentExecutionResult = {
        executionId: state.id,
        userId: state.userId,
        task: state.task,
        status: AGENT_STATUSES.COMPLETED,
        output: state.output,
        stepsCompleted: state.currentStep,
        toolCalls: state.toolCalls,
        trace: state.trace,
        sources: state.sources,
        plan: state.plan,
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

    if (state.plan) {
      state.plan.steps.forEach((s) => {
        if (s.status === "running") {
          s.status = "failed";
          s.error = fallbackError;
        } else if (s.status === "pending") {
          s.status = "skipped";
        }
      });
      callbacks?.onPlan?.(state.plan);
    }

    return {
      executionId: state.id,
      userId: state.userId,
      task: state.task,
      status: AGENT_STATUSES.FAILED,
      output: null,
      stepsCompleted: state.currentStep,
      toolCalls: state.toolCalls,
      trace: state.trace,
      sources: state.sources,
      plan: state.plan,
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

/**
 * Formats structured WebSearchOutput into a clearly indexed, 1-based source context for the AI,
 * complete with explicit inline citation instructions.
 */
export function formatWebSearchResultsForAI(output: any): string {
  if (!output || typeof output !== "object") {
    return JSON.stringify(output ?? null);
  }

  const rawResults: any[] = Array.isArray(output.results) ? output.results : [];
  const seenUrls = new Set<string>();
  const validResults: any[] = [];

  for (const item of rawResults) {
    if (item && isValidWebUrl(item.url)) {
      const url = item.url.trim();
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        validResults.push(item);
      }
    }
  }

  if (validResults.length === 0) {
    return typeof output.message === "string"
      ? output.message
      : `No web search results found for "${output.query || ""}".`;
  }

  const sections: string[] = ["[WEB SOURCES]"];
  validResults.forEach((item, index) => {
    const idx = index + 1;
    const title =
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : item.url.trim();
    const url = item.url.trim();
    const content =
      typeof item.content === "string" ? item.content.trim() : "";

    const lines = [`[${idx}] ${title}`, `URL: ${url}`];
    if (content) {
      lines.push(`Content: ${content}`);
    }
    sections.push(lines.join("\n"));
  });

  sections.push(WEB_SEARCH_CITATION_INSTRUCTIONS);

  return sections.join("\n\n");
}
