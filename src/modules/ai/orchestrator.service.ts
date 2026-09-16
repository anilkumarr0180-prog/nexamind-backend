import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app.error.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import {
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
} from "./providers/ai-provider.interface.js";
import { OllamaProvider } from "./providers/ollama.provider.js";

export const DEFAULT_CHAT_CREDIT_COST = 1;

export type ChatRequestInput = {
  conversationId: string;
  content: string;
};

export type OrchestratedChatResult = {
  conversation: {
    id: string;
    title: string;
    status: string;
    messageCount: number;
    lastMessageAt: Date | null;
  };
  userMessage: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    status: string;
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

let defaultProvider: AIProvider = new OllamaProvider();

export const setDefaultProvider = (provider: AIProvider): void => {
  defaultProvider = provider;
};

export const getDefaultProvider = (): AIProvider => {
  return defaultProvider;
};

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
      model: null,
      provider: null,
      usage: null,
    });

    // 5b. Retrieve bounded semantic memory context (non-fatal; fail-open)
    let memoryContext: string | null = null;
    try {
      memoryContext = await memoryService.getSemanticMemoryContextForUser(
        userId,
        trimmedContent,
        env.AI_MAX_MEMORY_CONTEXT,
      );
    } catch (memoryError) {
      console.error(
        "Non-fatal error retrieving memory context for AI chat; proceeding without memory:",
        memoryError,
      );
      memoryContext = null;
    }

    // 6. Build conversation context messages for AI provider
    const aiMessages = await buildConversationContext(
      conversation._id,
      env.AI_MAX_CONTEXT_MESSAGES,
      env.AI_MAX_CONTEXT_CHARS,
      memoryContext,
    );

    // 7. Invoke AI Provider
    const aiResponse = await provider.generateChatResponse(aiMessages);

    // 8. Persist ASSISTANT message
    assistantMessage = await messageRepository.createMessage({
      conversationId: conversation._id,
      userId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: aiResponse.content,
      status: MESSAGE_STATUSES.COMPLETED,
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
        },
      );
  } catch (metadataError) {
    console.error(
      "Non-fatal error updating conversation metadata after chat completion:",
      metadataError,
    );
  }

  // 9b. Non-critical automatic memory extraction
  try {
    await memoryService.extractAndSaveMemories(
      userId,
      {
        userMessageContent: userMessage.content,
        assistantMessageContent: assistantMessage.content,
      },
      provider,
    );
  } catch (extractionError) {
    console.error(
      "Non-fatal error during automatic memory extraction:",
      extractionError,
    );
  }

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
    },
    userMessage: {
      id: userMessage._id.toString(),
      conversationId: userMessage.conversationId.toString(),
      role: userMessage.role,
      content: userMessage.content,
      status: userMessage.status,
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
      usage: assistantMessage.usage ?? null,
      createdAt: assistantMessage.createdAt,
    },
    usage: assistantMessage.usage ?? null,
  };
};
