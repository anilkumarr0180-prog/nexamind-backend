import { isValidObjectId } from "mongoose";
import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import type {
  AIProvider,
  AIMessage,
} from "../ai/providers/ai-provider.interface.js";
import {
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentRunOptions,
  type AgentStreamCallbacks,
  AGENT_STATUSES,
} from "./agent.types.js";
import {
  AgentLoop,
  agentLoop as defaultAgentLoop,
} from "./agent.loop.js";
import { ToolRegistry } from "./tool.registry.js";
import "./tools/calculator.tool.js";
import { ToolExecutor } from "./tool.executor.js";
import { buildFullChatContext } from "../ai/context-builder.service.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import * as messageRepository from "../messages/message.repository.js";
import { MESSAGE_ROLES, MESSAGE_STATUSES } from "../messages/message.model.js";
import { summarizeConversationIfNeeded } from "../conversations/conversation-summary.service.js";
import * as memoryService from "../memory/memory.service.js";

/**
 * Default and boundary limits for agent execution steps.
 */
export const DEFAULT_MAX_STEPS = 10;
export const MAX_ALLOWED_STEPS = 25;
export const MIN_ALLOWED_STEPS = 1;

export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "You are NexaMind Agent, an intelligent autonomous agent capable of solving tasks using tools. When tools are available (such as calculator), you MUST use them to perform accurate calculations and operations.";

/**
 * Options for configuring an AgentService instance.
 */
export interface AgentServiceOptions {
  loop?: AgentLoop | undefined;
  provider?: AIProvider | undefined;
  registry?: ToolRegistry | undefined;
  executor?: ToolExecutor | undefined;
}

/**
 * Sanitizes and resolves maxSteps against safety boundaries.
 * Enforces minimum (1) and maximum (25) steps, preventing zero, negative, or unbounded execution.
 */
export const resolveMaxSteps = (maxSteps?: number): number => {
  if (
    typeof maxSteps !== "number" ||
    !Number.isFinite(maxSteps) ||
    maxSteps <= 0
  ) {
    return DEFAULT_MAX_STEPS;
  }

  const integerSteps = Math.floor(maxSteps);
  return Math.min(Math.max(MIN_ALLOWED_STEPS, integerSteps), MAX_ALLOWED_STEPS);
};

/**
 * Validates the required agent execution input.
 * Throws AppError with status 400 for invalid inputs.
 */
export const validateAgentInput = (input: AgentExecutionInput): void => {
  if (!input || typeof input !== "object") {
    throw new AppError(
      "Agent execution input must be an object",
      400,
      "INVALID_INPUT",
    );
  }

  const userId = input.userId?.trim();
  if (!userId) {
    throw new AppError("userId is required", 400, "INVALID_INPUT");
  }

  const task = input.task?.trim();
  if (!task) {
    throw new AppError("task is required and cannot be empty", 400, "INVALID_INPUT");
  }
};

/**
 * Application-level Agent Service.
 *
 * Validates execution inputs, applies step boundaries, builds shared context
 * (memories, conversation summary, recent messages) via Context Builder,
 * and delegates execution to the AgentLoop.
 */
export class AgentService {
  private readonly loop: AgentLoop;

  constructor(options?: AgentServiceOptions) {
    if (options?.loop) {
      this.loop = options.loop;
    } else if (options?.provider || options?.registry || options?.executor) {
      this.loop = new AgentLoop({
        provider: options.provider,
        registry: options.registry,
        executor: options.executor,
      });
    } else {
      this.loop = defaultAgentLoop;
    }
  }

  /**
   * Executes an autonomous agent task with validated input, bounded steps,
   * and shared conversational/memory context.
   */
  public async execute(
    input: AgentExecutionInput,
    runOptions?: AgentRunOptions,
  ): Promise<AgentExecutionResult> {
    // 1. Validate required execution input
    validateAgentInput(input);

    // 2. Resolve safe defaults and boundaries for maxSteps
    const sanitizedMaxSteps = resolveMaxSteps(input.maxSteps);

    const userId = input.userId.trim();
    const task = input.task.trim();
    const convId = input.conversationId?.trim() || undefined;

    // 3. Prepare sanitized execution payload
    const executionPayload: AgentExecutionInput = {
      userId,
      task,
      conversationId: convId,
      systemPrompt: input.systemPrompt?.trim() || DEFAULT_AGENT_SYSTEM_PROMPT,
      maxSteps: sanitizedMaxSteps,
      context: input.context,
      metadata: input.metadata,
    };

    let activeConversation: any = null;

    // 4. Context Builder & Conversation Integration
    if (convId && isValidObjectId(convId)) {
      // 4a. Verify conversation existence and user ownership
      const conversation =
        await conversationRepository.findConversationByIdAndUserId(
          convId,
          userId,
        );

      if (!conversation) {
        // Verify cross-user isolation: check if conv exists for any user
        const anyConv =
          await conversationRepository.findConversationById(convId);
        if (anyConv) {
          throw new AppError(
            "Conversation not found",
            404,
            "CONVERSATION_NOT_FOUND",
          );
        }
        throw new AppError(
          "Conversation not found",
          404,
          "CONVERSATION_NOT_FOUND",
        );
      }

      if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
        throw new AppError(
          "Archived conversations cannot accept new messages",
          400,
          "CONVERSATION_ARCHIVED",
        );
      }

      activeConversation = conversation;

      // 4b. Persist user task message to conversation
      try {
        const createdUserMsg = await messageRepository.createMessage({
          conversationId: conversation._id,
          userId,
          role: MESSAGE_ROLES.USER,
          content: task,
          status: MESSAGE_STATUSES.COMPLETED,
          model: null,
          provider: null,
          usage: null,
        });

        runOptions?.callbacks?.onStart?.({
          userMessage: {
            id: createdUserMsg._id.toString(),
            conversationId: createdUserMsg.conversationId.toString(),
            role: createdUserMsg.role,
            content: createdUserMsg.content,
            status: createdUserMsg.status,
            createdAt: createdUserMsg.createdAt,
          },
          conversationId: conversation._id.toString(),
        });
      } catch (err) {
        console.warn("Non-fatal error persisting agent user message:", err);
      }

      // 4c. Build unified bounded context using Context Builder
      // (combines recent messages, conversation summary, and user memories)
      try {
        const fullChatContext = await buildFullChatContext({
          userId,
          conversationId: conversation._id,
          userQuery: task,
          maxMessages: env.AI_MAX_CONTEXT_MESSAGES,
          maxChars: env.AI_MAX_CONTEXT_CHARS,
        });

        if (fullChatContext.length > 0) {
          executionPayload.initialMessages = fullChatContext;
        }
      } catch (contextErr) {
        console.warn("Non-fatal error building agent context:", contextErr);
      }
    } else if (!convId) {
      // 4d. Standalone Agent run without conversation: attach long-term memories if available
      try {
        const memoryContext =
          await memoryService.getSemanticMemoryContextForUser(
            userId,
            task,
            env.AI_MAX_MEMORY_CONTEXT,
          );
        if (memoryContext && memoryContext.trim()) {
          executionPayload.initialMessages = [
            {
              role: "user",
              content: `${memoryContext.trim()}\n\n${task}`,
            },
          ];
        }
      } catch (memErr) {
        // Fail-open: proceed without memory if retrieval fails
      }
    }

    // 5. Delegate execution to the AgentLoop
    const result = await this.loop.run(executionPayload, runOptions);

    // 6. Persist Agent completion or safe partial output to conversation
    const outputContent = result.output;
    const shouldPersistAssistantMsg =
      activeConversation &&
      typeof outputContent === "string" &&
      outputContent.trim().length > 0 &&
      (result.status === AGENT_STATUSES.COMPLETED ||
        result.status === AGENT_STATUSES.CANCELLED);

    if (shouldPersistAssistantMsg && outputContent) {
      try {
        const assistantMsg = await messageRepository.createMessage({
          conversationId: activeConversation._id,
          userId,
          role: MESSAGE_ROLES.ASSISTANT,
          content: outputContent,
          status: MESSAGE_STATUSES.COMPLETED,
          model: null,
          provider: null,
          usage: result.usage
            ? {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
              }
            : null,
        });

        const totalMessages = (activeConversation.messageCount || 0) + 2;
        await conversationRepository.updateConversation(
          activeConversation._id,
          userId,
          {
            lastMessageAt: assistantMsg.createdAt ?? new Date(),
            messageCount: totalMessages,
          },
        );

        // 7. Non-blocking automatic summarization check
        summarizeConversationIfNeeded(
          activeConversation._id.toString(),
          userId,
        ).catch((summaryErr) => {
          console.error(
            "Non-fatal error during agent post-run summarization:",
            summaryErr,
          );
        });
      } catch (persistErr) {
        console.warn("Non-fatal error persisting agent response:", persistErr);
      }
    }

    return result;
  }

  /**
   * Executes an agent task with real-time progressive streaming and safe tool status events.
   */
  public async executeStream(
    input: AgentExecutionInput,
    callbacks: AgentStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    return this.execute(input, { callbacks, signal });
  }
}

/**
 * Default global singleton instance of AgentService.
 */
export const agentService = new AgentService();

/**
 * Convenience helper function to execute an agent task through AgentService.
 */
export const executeAgentTask = async (
  input: AgentExecutionInput,
  options?: AgentServiceOptions,
): Promise<AgentExecutionResult> => {
  const service = options ? new AgentService(options) : agentService;
  return service.execute(input);
};
