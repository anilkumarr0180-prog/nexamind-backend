import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { MESSAGE_ROLES } from "../messages/message.model.js";
import * as messageRepository from "../messages/message.repository.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import * as conversationContinuityService from "../conversations/conversation-continuity.service.js";
import * as memoryService from "../memory/memory.service.js";
import * as attachmentRepository from "../attachments/attachment.repository.js";
import { ATTACHMENT_STATUSES, ATTACHMENT_TYPES } from "../attachments/attachment.types.js";
import type { AIMessage, AIProvider } from "./providers/ai-provider.interface.js";
export { NEXAMIND_CHAT_SYSTEM_PROMPT } from "./prompts/system.prompt.js";

export const DEFAULT_RECENT_MESSAGES_WITH_SUMMARY = 6;

/**
 * Maximum character budget for attached document text injected into prompt context.
 * Bounded to prevent document content from overwhelming the LLM context window.
 */
export const MAX_DOCUMENT_PROMPT_CHARS = 16000;

export interface DocumentAttachmentContext {
  originalName: string;
  mimeType?: string | undefined;
  extractedText: string;
}

export interface BuildFullChatContextOptions {
  userId: string | Types.ObjectId;
  conversationId: string | Types.ObjectId;
  userQuery: string;
  maxMessages?: number | undefined;
  maxChars?: number | undefined;
  recentMessagesWithSummary?: number | undefined;
  leafMessageId?: string | Types.ObjectId | null;
  customProvider?: AIProvider | undefined;
  imageUrl?: string | undefined;
  documentContext?: DocumentAttachmentContext | undefined;
}

/**
 * Safely bounds document text to prevent prompt overflow while providing a clear truncation notice.
 */
export const boundDocumentText = (
  text: string,
  maxChars: number = MAX_DOCUMENT_PROMPT_CHARS,
): { boundedText: string; isTruncated: boolean } => {
  if (text.length <= maxChars) {
    return { boundedText: text, isTruncated: false };
  }
  const truncationNotice = `\n\n[... Document truncated: ${text.length - maxChars} characters omitted for context length limits ...]`;
  const allowedLength = Math.max(0, maxChars - truncationNotice.length);
  return {
    boundedText: `${text.slice(0, allowedLength)}${truncationNotice}`,
    isTruncated: true,
  };
};

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
    options.leafMessageId,
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

  // 3b. Fetch cross-conversation continuity context if user query requests continuity
  let continuityContext: string | null = null;
  if (effectiveQuery) {
    try {
      continuityContext =
        await conversationContinuityService.getContinuityContextForUser({
          userId: options.userId,
          currentConversationId: options.conversationId,
          userQuery: effectiveQuery,
          customProvider: options.customProvider,
          recentMessages: mappedMessages.slice(0, -1),
        });
    } catch (continuityErr) {
      console.warn(
        "Non-fatal error retrieving continuity context for context builder:",
        continuityErr,
      );
      continuityContext = null;
    }
  }

  // 3c. Resolve document attachment context (either passed explicitly or from latest message attachment)
  let docContext = options.documentContext;
  if (!docContext && recentMessages.length > 0) {
    const latestMessageRecord = recentMessages[recentMessages.length - 1];
    if (latestMessageRecord?.attachmentId) {
      try {
        const att = await attachmentRepository.findAttachmentByIdAndUserId(
          latestMessageRecord.attachmentId,
          options.userId,
        );
        if (
          att &&
          att.type === ATTACHMENT_TYPES.DOCUMENT &&
          att.status === ATTACHMENT_STATUSES.READY &&
          att.conversationId.toString() === options.conversationId.toString() &&
          att.extractedText
        ) {
          docContext = {
            originalName: att.originalName,
            mimeType: att.mimeType,
            extractedText: att.extractedText,
          };
        }
      } catch (attErr) {
        console.warn(
          "Non-fatal error retrieving attachment for context builder:",
          attErr,
        );
      }
    }
  }

  let documentSection: string | null = null;
  if (docContext && docContext.extractedText && docContext.extractedText.trim().length > 0) {
    const docBudget = Math.min(MAX_DOCUMENT_PROMPT_CHARS, maxChars);
    const { boundedText } = boundDocumentText(docContext.extractedText, docBudget);
    documentSection = `--- Attached Document: ${docContext.originalName} ---\n${boundedText}\n--- End of Attached Document ---`;
  }

  // 4. Combine metadata sections deterministically:
  // Order: Relevant user memories -> Previous conversation context (continuity) -> Current conversation summary -> Attached document
  const contextSections: string[] = [];
  if (memoryContext && memoryContext.trim()) {
    contextSections.push(memoryContext.trim());
  }
  if (continuityContext && continuityContext.trim()) {
    contextSections.push(continuityContext.trim());
  }
  if (conversationSummary && conversationSummary.trim()) {
    const trimmedSummary = conversationSummary.trim();
    // Prevent duplicate conversation summaries from being added to the AI context.
    // Also, if continuityContext was retrieved, omit any negative self-poisoned summary claiming no memory
    const isUncertainSummary =
      /lacks? (?:memory|record)|does not retain|clarifies lack of memory|state of uncertainty/i.test(
        trimmedSummary,
      );
    if (!continuityContext || (!continuityContext.includes(trimmedSummary) && !isUncertainSummary)) {
      contextSections.push(`Conversation summary:\n${trimmedSummary}`);
    }
  }
  if (documentSection && documentSection.trim()) {
    contextSections.push(documentSection.trim());
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
    ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
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
