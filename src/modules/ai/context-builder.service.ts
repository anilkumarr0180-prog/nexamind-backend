import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { MESSAGE_ROLES } from "../messages/message.model.js";
import { Message } from "../messages/message.model.js";
import * as messageRepository from "../messages/message.repository.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import * as memoryService from "../memory/memory.service.js";
import type { AIMessage } from "./providers/ai-provider.interface.js";

export const DEFAULT_RECENT_MESSAGES_WITH_SUMMARY = 6;

export const getCrossConversationHistoryContext = async (
  userId: string | Types.ObjectId,
  excludeConversationId?: string | Types.ObjectId,
  maxConversations: number = 2,
  maxTotalChars: number = 350,
): Promise<string | null> => {
  try {
    const otherConversations =
      await conversationRepository.findRecentOtherConversationsForUser(
        userId,
        excludeConversationId,
        maxConversations,
      );

    if (!otherConversations || otherConversations.length === 0) {
      return null;
    }

    const lines: string[] = [];
    let currentChars = 0;

    for (const conv of otherConversations) {
      const title = conv.title?.trim() || "Untitled conversation";

      // Fetch the last completed message in this other conversation
      const lastMsg = await Message.findOne({
        conversationId: conv._id,
        status: "COMPLETED",
      })
        .sort({ createdAt: -1 })
        .lean();

      let line = `- "${title}"`;
      if (lastMsg && lastMsg.content) {
        // Sanitize and truncate content excerpt (max 120 chars)
        const cleanContent = lastMsg.content
          .replace(/\s+/g, " ")
          .slice(0, 120)
          .trim();
        if (cleanContent) {
          line += `: Last message: "${cleanContent}"`;
        }
      }

      if (currentChars + line.length > maxTotalChars && lines.length > 0) {
        break;
      }

      lines.push(line);
      currentChars += line.length;
    }

    if (lines.length === 0) {
      return null;
    }

    return `Recent conversation history:\n${lines.join("\n")}`;
  } catch (err) {
    console.warn(
      "Non-fatal error retrieving cross-conversation context, proceeding without it:",
      err,
    );
    return null;
  }
};

export interface BuildFullChatContextOptions {
  userId: string | Types.ObjectId;
  conversationId: string | Types.ObjectId;
  userQuery: string;
  maxMessages?: number | undefined;
  maxChars?: number | undefined;
  recentMessagesWithSummary?: number | undefined;
}

export const buildFullChatContext = async (
  options: BuildFullChatContextOptions,
): Promise<AIMessage[]> => {
  const maxMessages = options.maxMessages ?? env.AI_MAX_CONTEXT_MESSAGES;
  const maxChars = options.maxChars ?? env.AI_MAX_CONTEXT_CHARS;
  const recentLimitWithSummary =
    options.recentMessagesWithSummary ?? DEFAULT_RECENT_MESSAGES_WITH_SUMMARY;

  // 1. Fetch active conversation to check for persisted summary
  let conversationSummary: string | null = null;
  try {
    const activeConv =
      await conversationRepository.findConversationByIdAndUserId(
        options.conversationId,
        options.userId,
      );
    if (activeConv?.summary && activeConv.summary.trim().length > 0) {
      conversationSummary = activeConv.summary.trim();
    }
  } catch (convErr) {
    console.warn(
      "Non-fatal error retrieving conversation summary for context builder:",
      convErr,
    );
    conversationSummary = null;
  }

  // When a summary exists, older raw messages are replaced by the summary.
  // We only fetch the recent message window instead of the full maxMessages.
  const effectiveMaxMessages = conversationSummary
    ? Math.min(maxMessages, recentLimitWithSummary)
    : maxMessages;

  // 2. Fetch active conversation recent completed messages
  const recentMessages = await messageRepository.findRecentMessagesForContext(
    options.conversationId,
    effectiveMaxMessages,
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

  // 3. Fetch semantic memory context (fail-open)
  let memoryContext: string | null = null;
  try {
    memoryContext = await memoryService.getSemanticMemoryContextForUser(
      options.userId.toString(),
      options.userQuery,
      env.AI_MAX_MEMORY_CONTEXT,
    );
  } catch (memErr) {
    console.warn(
      "Non-fatal error retrieving memory context for context builder:",
      memErr,
    );
    memoryContext = null;
  }

  // 4. Fetch cross-conversation history context (fail-open)
  let crossConversationContext: string | null = null;
  try {
    crossConversationContext = await getCrossConversationHistoryContext(
      options.userId,
      options.conversationId,
    );
  } catch (convErr) {
    console.warn(
      "Non-fatal error retrieving cross-conversation context:",
      convErr,
    );
    crossConversationContext = null;
  }

  // 5. Combine metadata sections deterministically:
  // Order: Relevant user memories -> Conversation summary -> Recent conversation history
  const contextSections: string[] = [];
  if (memoryContext && memoryContext.trim()) {
    contextSections.push(memoryContext.trim());
  }
  if (conversationSummary && conversationSummary.trim()) {
    contextSections.push(`Conversation summary:\n${conversationSummary.trim()}`);
  }
  if (crossConversationContext && crossConversationContext.trim()) {
    contextSections.push(crossConversationContext.trim());
  }
  const combinedMetadata =
    contextSections.length > 0 ? contextSections.join("\n\n") : null;

  // 6. Inject into latest user message and apply character budgeting
  const rawLatestContent = combinedMetadata
    ? `${combinedMetadata}\n\n${latestMessage.content}`
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
    if (!msg) continue;
    if (msg.content.length <= remainingChars) {
      historyMessages.unshift(msg);
      remainingChars -= msg.content.length;
    } else {
      break;
    }
  }

  return [...historyMessages, finalLatestMessage];
};
