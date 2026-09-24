import { summarizeConversationIfNeeded } from "../conversations/conversation-summary.service.js";
import { buildFullChatContext } from "./context-builder.service.js";
import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app.error.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import {
  Message,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "../messages/message.model.js";
import * as messageRepository from "../messages/message.repository.js";
import * as tokenService from "../tokens/token.service.js";
import * as memoryService from "../memory/memory.service.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIUsage,
} from "./providers/ai-provider.interface.js";
import { OllamaProvider } from "./providers/ollama.provider.js";
import { GroqProvider } from "./providers/groq.provider.js";

const activeGenerations = new Set<string>();

export const isGenerationActiveForConversation = (conversationId: string): boolean => {
  return activeGenerations.has(conversationId);
};

export const clearActiveGenerations = (): void => {
  activeGenerations.clear();
};

const resolveBranchForChat = async (
  conversation: any,
  userId: string,
  editMessageId?: string,
): Promise<{
  parentMessageId: Types.ObjectId | null;
  originalMessageId: Types.ObjectId | null;
}> => {
  if (!editMessageId) {
    return {
      parentMessageId: conversation.activeLeafMessageId ?? null,
      originalMessageId: null,
    };
  }

  const origMsg = await messageRepository.findMessageById(editMessageId);
  if (!origMsg || origMsg.conversationId.toString() !== conversation._id.toString()) {
    throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
  }

  if (origMsg.userId.toString() !== userId.toString()) {
    throw new AppError("You cannot edit another user's message", 403, "FORBIDDEN");
  }

  if (origMsg.role !== MESSAGE_ROLES.USER) {
    throw new AppError("Only user messages can be edited and regenerated", 400, "INVALID_MESSAGE_ROLE");
  }

  if (origMsg.status !== MESSAGE_STATUSES.COMPLETED) {
    throw new AppError("Only completed messages can be edited", 400, "INVALID_MESSAGE_STATE");
  }

  let branchParentId: Types.ObjectId | null = (origMsg as any).parentMessageId ?? null;
  if (!branchParentId) {
    const prevMsg = await Message.findOne({
      conversationId: conversation._id,
      createdAt: { $lt: origMsg.createdAt },
      status: MESSAGE_STATUSES.COMPLETED,
    }).sort({ createdAt: -1 });

    if (prevMsg) {
      branchParentId = prevMsg._id;
    }
  }

  return {
    parentMessageId: branchParentId,
    originalMessageId: (origMsg as any).originalMessageId ?? origMsg._id,
  };
};

export const DEFAULT_CHAT_CREDIT_COST = 1;

export type ChatRequestInput = {
  conversationId: string;
  content: string;
  editMessageId?: string | undefined;
};

export type OrchestratedChatResult = {
  conversation: {
    id: string;
    title: string;
    status: string;
    messageCount: number;
    lastMessageAt: Date | null;
    activeLeafMessageId?: string | null;
  };
  userMessage: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    status: string;
    parentMessageId?: string | null;
    originalMessageId?: string | null;
    createdAt: Date;
  };
  assistantMessage: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    status: string;
    model: string | null;
    provider: string | null;
    parentMessageId?: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
    createdAt: Date;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
};

const createDefaultProvider = (): AIProvider => {
  if (env.AI_PROVIDER === "groq") {
    return new GroqProvider();
  }
  return new OllamaProvider();
};

let defaultProvider: AIProvider = createDefaultProvider();

export const setDefaultProvider = (provider: AIProvider): void => {
  defaultProvider = provider;
};

export const getDefaultProvider = (): AIProvider => {
  return defaultProvider;
};

export { buildFullChatContext };
export const buildConversationContext = async (
  conversationId: string | Types.ObjectId,
  maxMessages: number = env.AI_MAX_CONTEXT_MESSAGES,
  maxChars: number = env.AI_MAX_CONTEXT_CHARS,
  memoryContext?: string | null,
): Promise<AIMessage[]> => {
  const recentMessages = await messageRepository.findRecentMessagesForContext(
    conversationId,
    maxMessages,
  );

  if (recentMessages.length === 0) {
    return [];
  }

  const mappedMessages: AIMessage[] = recentMessages.map((msg) => ({
    role:
      msg.role === MESSAGE_ROLES.ASSISTANT
        ? "assistant"
        : msg.role === MESSAGE_ROLES.SYSTEM
          ? "system"
          : "user",
    content: msg.content,
  }));

  const latestMessage = mappedMessages[mappedMessages.length - 1];
  if (!latestMessage) {
    return [];
  }

  const rawLatestContent = memoryContext
    ? `${memoryContext}\n\n${latestMessage.content}`
    : latestMessage.content;

  const cappedLatestContent =
    rawLatestContent.length > maxChars
      ? rawLatestContent.slice(0, Math.max(0, maxChars))
      : rawLatestContent;

  const finalLatestMessage: AIMessage = {
    role: latestMessage.role,
    content: cappedLatestContent,
  };

  let remainingChars = maxChars - finalLatestMessage.content.length;

  const historyMessages: AIMessage[] = [];
  for (let i = mappedMessages.length - 2; i >= 0; i--) {
    const msg = mappedMessages[i];
    if (!msg) {
      continue;
    }
    if (msg.content.length <= remainingChars) {
      historyMessages.unshift(msg);
      remainingChars -= msg.content.length;
    } else {
      break;
    }
  }

  return [...historyMessages, finalLatestMessage];
};

export const processChatRequest = async (
  userId: string,
  input: ChatRequestInput,
  customProvider?: AIProvider,
): Promise<OrchestratedChatResult> => {
  if (activeGenerations.has(input.conversationId)) {
    throw new AppError(
      "Another AI generation is currently active for this conversation",
      409,
      "GENERATION_IN_PROGRESS",
    );
  }
  activeGenerations.add(input.conversationId);

  try {
    const provider = customProvider ?? defaultProvider;

    // 1. Verify conversation ownership and existence
    const conversation =
      await conversationRepository.findConversationByIdAndUserId(
        input.conversationId,
        userId,
      );

    if (!conversation) {
      throw new AppError(
        "Conversation not found",
        404,
        "CONVERSATION_NOT_FOUND",
      );
    }

    // 2. Verify conversation status
    if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
      throw new AppError(
        "Archived conversations cannot accept new messages",
        400,
        "CONVERSATION_ARCHIVED",
      );
    }

    if (conversation.status !== CONVERSATION_STATUSES.ACTIVE) {
      throw new AppError(
        "Conversation is not active",
        400,
        "CONVERSATION_NOT_ACTIVE",
      );
    }

    // 3. Validate user message content
    const trimmedContent = input.content?.trim();
    if (!trimmedContent) {
      throw new AppError(
        "Message content is required",
        400,
        "INVALID_INPUT",
      );
    }

    // 3b. Resolve branch parent and original message before credit deduction
    const { parentMessageId: branchParentId, originalMessageId } =
      await resolveBranchForChat(conversation, userId, input.editMessageId);

    // 4. Deduct application credits atomically BEFORE invoking the AI provider
    await tokenService.deductCredits(userId, DEFAULT_CHAT_CREDIT_COST);

    let userMessage:
      | Awaited<ReturnType<typeof messageRepository.createMessage>>
      | undefined;
    let assistantMessage:
      | Awaited<ReturnType<typeof messageRepository.createMessage>>
      | undefined;

    try {
      // 5. Persist USER message
      userMessage = await messageRepository.createMessage({
        conversationId: conversation._id,
        userId,
        role: MESSAGE_ROLES.USER,
        content: trimmedContent,
        status: MESSAGE_STATUSES.COMPLETED,
        parentMessageId: branchParentId,
        originalMessageId,
        model: null,
        provider: null,
        usage: null,
      });

      // 6. Build conversation context messages for AI provider via Context Builder
      const aiMessages = await buildFullChatContext({
        userId,
        conversationId: conversation._id,
        userQuery: trimmedContent,
        maxMessages: env.AI_MAX_CONTEXT_MESSAGES,
        maxChars: env.AI_MAX_CONTEXT_CHARS,
        leafMessageId: userMessage._id,
        customProvider: provider,
      });

      // 7. Invoke AI Provider
      const aiResponse = await provider.generateChatResponse(aiMessages);

      // 8. Persist ASSISTANT message
      assistantMessage = await messageRepository.createMessage({
        conversationId: conversation._id,
        userId,
        role: MESSAGE_ROLES.ASSISTANT,
        content: aiResponse.content,
        status: MESSAGE_STATUSES.COMPLETED,
        parentMessageId: userMessage._id,
        model: aiResponse.model,
        provider: aiResponse.provider,
        usage: aiResponse.usage,
      });
  } catch (executionError: unknown) {
    // Compensate / refund deducted credits
    try {
      await tokenService.refundCredits(userId, DEFAULT_CHAT_CREDIT_COST);
    } catch (refundError) {
      console.error(
        "Credit refund failed during AI chat failure compensation:",
        refundError,
      );
    }

    // Mark user message as FAILED to maintain consistency if it was created
    if (userMessage?._id) {
      try {
        await messageRepository.updateMessageStatus(
          userMessage._id,
          MESSAGE_STATUSES.FAILED,
        );
      } catch (updateError) {
        console.error(
          "Failed to update user message status to FAILED:",
          updateError,
        );
      }
    }

    if (executionError instanceof AppError) {
      throw executionError;
    }

    const execErrMsg = executionError instanceof Error ? executionError.message : "AI provider failed to generate response";
    if (execErrMsg.toLowerCase().includes("too large") || execErrMsg.toLowerCase().includes("entity too large")) {
      throw new AppError(
        "AI request is too large. Please start a new conversation or shorten the context.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }

    throw new AppError(
      "AI provider failed to generate response",
      502,
      "AI_PROVIDER_ERROR",
    );
  }

  if (!userMessage || !assistantMessage) {
    throw new AppError(
      "Failed to complete AI chat orchestration",
      500,
      "INTERNAL_ERROR",
    );
  }

  // 9. Update conversation metadata (non-fatal; ancillary metadata glitch must not fail successful chat)
  let totalMessages = 0;
  let updatedConversation:
    | Awaited<ReturnType<typeof conversationRepository.updateConversation>>
    | null = null;

  try {
    totalMessages =
      await messageRepository.countMessagesByConversationId(
        conversation._id,
      );

    updatedConversation =
      await conversationRepository.updateConversation(
        conversation._id,
        userId,
        {
          lastMessageAt: assistantMessage.createdAt ?? new Date(),
          messageCount: totalMessages,
          activeLeafMessageId: assistantMessage._id,
        },
      );
  } catch (metadataError) {
    console.error(
      "Non-fatal error updating conversation metadata after chat completion:",
      metadataError,
    );
  }

  // 9b. Non-critical automatic memory extraction (non-blocking)
  memoryService
    .extractAndSaveMemories(
      userId,
      {
        userMessageContent: userMessage.content,
        assistantMessageContent: assistantMessage.content,
      },
      provider,
    )
    .catch((extractionError) => {
      console.error(
        "Non-fatal error during automatic memory extraction:",
        extractionError,
      );
    });

  // 9c. Non-critical automatic conversation summarization (non-blocking)
  summarizeConversationIfNeeded(
    conversation._id.toString(),
    userId,
    provider,
  ).catch((summaryError) => {
    console.error(
      "Non-fatal error during conversation summarization:",
      summaryError,
    );
  });

  // 10. Return clean API response
  return {
    conversation: {
      id: (updatedConversation?._id ?? conversation._id).toString(),
      title: updatedConversation?.title ?? conversation.title,
      status: updatedConversation?.status ?? conversation.status,
      messageCount:
        updatedConversation?.messageCount ?? totalMessages,
      lastMessageAt:
        updatedConversation?.lastMessageAt ??
        assistantMessage.createdAt ??
        new Date(),
      activeLeafMessageId:
        (updatedConversation?.activeLeafMessageId ?? assistantMessage._id)?.toString() ?? null,
    },
    userMessage: {
      id: userMessage._id.toString(),
      conversationId: userMessage.conversationId.toString(),
      role: userMessage.role,
      content: userMessage.content,
      status: userMessage.status,
      parentMessageId: (userMessage as any).parentMessageId?.toString() ?? null,
      originalMessageId: (userMessage as any).originalMessageId?.toString() ?? null,
      createdAt: userMessage.createdAt,
    },
    assistantMessage: {
      id: assistantMessage._id.toString(),
      conversationId: assistantMessage.conversationId.toString(),
      role: assistantMessage.role,
      content: assistantMessage.content,
      status: assistantMessage.status,
      model: assistantMessage.model ?? null,
      provider: assistantMessage.provider ?? null,
      parentMessageId: (assistantMessage as any).parentMessageId?.toString() ?? null,
      usage: assistantMessage.usage ?? null,
      createdAt: assistantMessage.createdAt,
    },
    usage: assistantMessage.usage ?? null,
  };
  } finally {
    activeGenerations.delete(input.conversationId);
  }
};


export interface ChatStreamCallbacks {
  onStart?: (data: {
    userMessage: {
      id: string;
      conversationId: string;
      role: string;
      content: string;
      status: string;
      parentMessageId?: string | null;
      originalMessageId?: string | null;
      createdAt: Date;
    };
    conversationId: string;
  }) => void;
  onChunk: (chunk: string) => void;
}

export const processChatStream = async (
  userId: string,
  input: ChatRequestInput,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
  customProvider?: AIProvider,
): Promise<OrchestratedChatResult | null> => {
  if (activeGenerations.has(input.conversationId)) {
    throw new AppError(
      "Another AI generation is currently active for this conversation",
      409,
      "GENERATION_IN_PROGRESS",
    );
  }
  activeGenerations.add(input.conversationId);

  try {
    const provider = customProvider ?? defaultProvider;

    // 1. Verify conversation ownership and existence
    const conversation =
      await conversationRepository.findConversationByIdAndUserId(
        input.conversationId,
        userId,
      );

    if (!conversation) {
      throw new AppError(
        "Conversation not found",
        404,
        "CONVERSATION_NOT_FOUND",
      );
    }

    // 2. Verify conversation status
    if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
      throw new AppError(
        "Archived conversations cannot accept new messages",
        400,
        "CONVERSATION_ARCHIVED",
      );
    }

    if (conversation.status !== CONVERSATION_STATUSES.ACTIVE) {
      throw new AppError(
        "Conversation is not active",
        400,
        "CONVERSATION_NOT_ACTIVE",
      );
    }

    // 3. Validate user message content
    const trimmedContent = input.content?.trim();
    if (!trimmedContent) {
      throw new AppError(
        "Message content is required",
        400,
        "INVALID_INPUT",
      );
    }

    // 3b. Resolve branch parent and original message before credit deduction
    const { parentMessageId: branchParentId, originalMessageId } =
      await resolveBranchForChat(conversation, userId, input.editMessageId);

    // 4. Deduct application credits atomically BEFORE invoking the AI provider
    await tokenService.deductCredits(userId, DEFAULT_CHAT_CREDIT_COST);

    let userMessage:
      | Awaited<ReturnType<typeof messageRepository.createMessage>>
      | undefined;
    let assistantMessage:
      | Awaited<ReturnType<typeof messageRepository.createMessage>>
      | undefined;

    let fullAssistantContent = "";
    let capturedModel: string | null = null;
    let capturedUsage: AIUsage | null = null;
    let streamError: unknown = null;

    try {
      // 5. Persist USER message
      userMessage = await messageRepository.createMessage({
        conversationId: conversation._id,
        userId,
        role: MESSAGE_ROLES.USER,
        content: trimmedContent,
        status: MESSAGE_STATUSES.COMPLETED,
        parentMessageId: branchParentId,
        originalMessageId,
        model: null,
        provider: null,
        usage: null,
      });

      // Notify caller that stream has started with the created user message
      callbacks.onStart?.({
        userMessage: {
          id: userMessage._id.toString(),
          conversationId: userMessage.conversationId.toString(),
          role: userMessage.role,
          content: userMessage.content,
          status: userMessage.status,
          parentMessageId: (userMessage as any).parentMessageId?.toString() ?? null,
          originalMessageId: (userMessage as any).originalMessageId?.toString() ?? null,
          createdAt: userMessage.createdAt,
        },
        conversationId: conversation._id.toString(),
      });

      // 6. Build conversation context messages for AI provider via Context Builder
      const aiMessages = await buildFullChatContext({
        userId,
        conversationId: conversation._id,
        userQuery: trimmedContent,
        maxMessages: env.AI_MAX_CONTEXT_MESSAGES,
        maxChars: env.AI_MAX_CONTEXT_CHARS,
        leafMessageId: userMessage._id,
        customProvider: provider,
      });

    // 7. Invoke AI Provider Streaming
    if (typeof provider.generateChatStream !== "function") {
      throw new AppError(
        `Provider "${provider.name}" does not support streaming`,
        500,
        "STREAMING_NOT_SUPPORTED",
      );
    }

    for await (const chunk of provider.generateChatStream(aiMessages, undefined, signal)) {
      if (signal?.aborted) {
        break;
      }
      if (typeof chunk.content === "string" && chunk.content.length > 0) {
        fullAssistantContent += chunk.content;
        callbacks.onChunk(chunk.content);
      }
      if (chunk.model) {
        capturedModel = chunk.model;
      }
      if (chunk.usage) {
        capturedUsage = chunk.usage;
      }
    }
  } catch (executionError: unknown) {
    streamError = executionError;
  }

  const hasMeaningfulContent = fullAssistantContent.trim().length > 0;

  // 1. CLIENT ABORT (Stop Generating / Premature Client Disconnect)
  if (signal?.aborted) {
    if (!hasMeaningfulContent) {
      // Aborted before ANY content was produced: refund credit & mark user message failed
      try {
        await tokenService.refundCredits(userId, DEFAULT_CHAT_CREDIT_COST);
      } catch (refundError) {
        console.error("Credit refund failed on client abort before content:", refundError);
      }
      if (userMessage?._id) {
        try {
          await messageRepository.updateMessageStatus(
            userMessage._id,
            MESSAGE_STATUSES.FAILED,
          );
        } catch {}
      }
      return null;
    }
    // Partial content exists: keep deducted credit and persist partial assistant message below
  }

  // 2. PROVIDER FAILURE with ZERO CONTENT
  if (streamError && !hasMeaningfulContent) {
    try {
      await tokenService.refundCredits(userId, DEFAULT_CHAT_CREDIT_COST);
    } catch (refundError) {
      console.error(
        "Credit refund failed during AI chat stream failure compensation:",
        refundError,
      );
    }
    if (userMessage?._id) {
      try {
        await messageRepository.updateMessageStatus(
          userMessage._id,
          MESSAGE_STATUSES.FAILED,
        );
      } catch (updateError) {
        console.error(
          "Failed to update user message status to FAILED:",
          updateError,
        );
      }
    }

    if (streamError instanceof AppError) {
      throw streamError;
    }
    const streamErrMsg = streamError instanceof Error ? streamError.message : "AI provider failed to generate response";
    if (streamErrMsg.toLowerCase().includes("too large") || streamErrMsg.toLowerCase().includes("entity too large")) {
      throw new AppError(
        "AI request is too large. Please start a new conversation or shorten the context.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
    throw new AppError(
      streamErrMsg,
      502,
      "AI_PROVIDER_ERROR",
    );
  }

  // 3. ZERO-CONTENT RESPONSE (Stream finished normally with zero content)
  if (!signal?.aborted && !hasMeaningfulContent) {
    try {
      await tokenService.refundCredits(userId, DEFAULT_CHAT_CREDIT_COST);
    } catch {}
    if (userMessage?._id) {
      try {
        await messageRepository.updateMessageStatus(
          userMessage._id,
          MESSAGE_STATUSES.FAILED,
        );
      } catch {}
    }
    throw new AppError(
      "AI provider returned an empty response",
      502,
      "AI_PROVIDER_ERROR",
    );
  }

  if (!userMessage) {
    throw new AppError(
      "Failed to initialize AI chat stream",
      500,
      "INTERNAL_ERROR",
    );
  }

  // At this point, hasMeaningfulContent is true
  const fallbackUsage: AIUsage = capturedUsage ?? {
    inputTokens: Math.ceil(trimmedContent.length / 4),
    outputTokens: Math.ceil(fullAssistantContent.length / 4),
    totalTokens: Math.ceil((trimmedContent.length + fullAssistantContent.length) / 4),
  };

  // 8. Persist ASSISTANT message (normal completion, partial response, or abort with content)
  assistantMessage = await messageRepository.createMessage({
    conversationId: conversation._id,
    userId,
    role: MESSAGE_ROLES.ASSISTANT,
    content: fullAssistantContent,
    status: MESSAGE_STATUSES.COMPLETED,
    parentMessageId: userMessage._id,
    model: capturedModel ?? (provider.name === "groq" ? "qwen/qwen3.8-27b" : "llama3.2:3b"),
    provider: provider.name,
    usage: fallbackUsage,
  });

  // 9. Update conversation metadata
  let totalMessages = 0;
  let updatedConversation:
    | Awaited<ReturnType<typeof conversationRepository.updateConversation>>
    | null = null;

  try {
    totalMessages =
      await messageRepository.countMessagesByConversationId(
        conversation._id,
      );

    updatedConversation =
      await conversationRepository.updateConversation(
        conversation._id,
        userId,
        {
          lastMessageAt: assistantMessage.createdAt ?? new Date(),
          messageCount: totalMessages,
          activeLeafMessageId: assistantMessage._id,
        },
      );
  } catch (metadataError) {
    console.error(
      "Non-fatal error updating conversation metadata after stream completion:",
      metadataError,
    );
  }

  // 4. PARTIAL RESPONSE with PROVIDER FAILURE:
  // If provider failed AFTER meaningful content was produced, partial response is preserved in DB,
  // credit is kept, and the genuine provider error is re-thrown (do NOT hide provider error).
  if (streamError) {
    if (streamError instanceof AppError) {
      throw streamError;
    }
    const streamErrMsg = streamError instanceof Error ? streamError.message : "AI provider failed to generate response";
    if (streamErrMsg.toLowerCase().includes("too large") || streamErrMsg.toLowerCase().includes("entity too large")) {
      throw new AppError(
        "AI request is too large. Please start a new conversation or shorten the context.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
    throw new AppError(
      streamErrMsg,
      502,
      "AI_PROVIDER_ERROR",
    );
  }

  // 5. SUCCESSFUL COMPLETION (no stream error, not aborted)
  // 9b. Non-critical automatic memory extraction (non-blocking)
  if (!signal?.aborted) {
    memoryService
      .extractAndSaveMemories(
        userId,
        {
          userMessageContent: userMessage.content,
          assistantMessageContent: assistantMessage.content,
        },
        provider,
      )
      .catch((extractionError) => {
        console.error(
          "Non-fatal error during automatic memory extraction:",
          extractionError,
        );
      });
  }

  // 9c. Non-critical automatic conversation summarization (non-blocking)
  if (!signal?.aborted) {
    summarizeConversationIfNeeded(
      conversation._id.toString(),
      userId,
      provider,
    ).catch((summaryError) => {
      console.error(
        "Non-fatal error during conversation summarization:",
        summaryError,
      );
    });
  }

  // 10. Return clean API response
  return {
    conversation: {
      id: (updatedConversation?._id ?? conversation._id).toString(),
      title: updatedConversation?.title ?? conversation.title,
      status: updatedConversation?.status ?? conversation.status,
      messageCount: updatedConversation?.messageCount ?? totalMessages,
      lastMessageAt:
        updatedConversation?.lastMessageAt ??
        assistantMessage.createdAt ??
        new Date(),
      activeLeafMessageId:
        (updatedConversation?.activeLeafMessageId ?? assistantMessage._id)?.toString() ?? null,
    },
    userMessage: {
      id: userMessage._id.toString(),
      conversationId: userMessage.conversationId.toString(),
      role: userMessage.role,
      content: userMessage.content,
      status: userMessage.status,
      parentMessageId: (userMessage as any).parentMessageId?.toString() ?? null,
      originalMessageId: (userMessage as any).originalMessageId?.toString() ?? null,
      createdAt: userMessage.createdAt,
    },
    assistantMessage: {
      id: assistantMessage._id.toString(),
      conversationId: assistantMessage.conversationId.toString(),
      role: assistantMessage.role,
      content: assistantMessage.content,
      status: assistantMessage.status,
      model: assistantMessage.model ?? null,
      provider: assistantMessage.provider ?? null,
      parentMessageId: (assistantMessage as any).parentMessageId?.toString() ?? null,
      usage: assistantMessage.usage ?? null,
      createdAt: assistantMessage.createdAt,
    },
    usage: assistantMessage.usage ?? null,
  };
  } finally {
    activeGenerations.delete(input.conversationId);
  }
};
