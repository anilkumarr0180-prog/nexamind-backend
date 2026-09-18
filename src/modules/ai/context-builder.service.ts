import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { MESSAGE_ROLES } from "../messages/message.model.js";
import * as messageRepository from "../messages/message.repository.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import * as memoryService from "../memory/memory.service.js";
import type { AIMessage } from "./providers/ai-provider.interface.js";
export { NEXAMIND_CHAT_SYSTEM_PROMPT } from "./prompts/system.prompt.js";

export const DEFAULT_RECENT_MESSAGES_WITH_SUMMARY = 6;

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

  // 1. Fetch active conversation to check for persisted summary (scoped to conversationId + userId)
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

  // 2. Fetch active conversation recent completed messages (scoped strictly to conversationId)
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

  // 3. Fetch semantic memory context scoped strictly to authenticated user (fail-open)
  const effectiveQuery =
    options.userQuery ?? (latestMessage.role === "user" ? latestMessage.content : null);

  let memoryContext: string | null = null;
  try {
    memoryContext = await memoryService.getSemanticMemoryContextForUser(
      options.userId.toString(),
      effectiveQuery,
      env.AI_MAX_MEMORY_CONTEXT,
    );
  } catch (memErr) {
    console.warn(
      "Non-fatal error retrieving memory context for context builder:",
      memErr,
    );
    memoryContext = null;
  }

  // 4. Combine metadata sections deterministically:
  // Order: Relevant user memories -> Conversation summary
  const contextSections: string[] = [];
  if (memoryContext && memoryContext.trim()) {
    contextSections.push(memoryContext.trim());
  }
  if (conversationSummary && conversationSummary.trim()) {
    contextSections.push(`Conversation summary:\n${conversationSummary.trim()}`);
  }
  const combinedMetadata =
    contextSections.length > 0 ? contextSections.join("\n\n") : null;

  // 5. Inject into latest user message and apply character budgeting
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
