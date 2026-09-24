import type { Types } from "mongoose";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../messages/message.model.js";
import * as conversationRepository from "./conversation.repository.js";
import * as orchestratorService from "../ai/orchestrator.service.js";
import type {
  AIProvider,
  AIMessage,
} from "../ai/providers/ai-provider.interface.js";

export const MIN_MESSAGES_FOR_SUMMARY = 2;
export const SUMMARY_TRIGGER_INTERVAL = 6;
export const MAX_SUMMARY_CHARS = 1500;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarization system for NexaMind AI.
Your task is to produce a concise, structured summary of the conversation so far.
The summary will be used as context for future turns so the assistant knows what has been discussed, what technical decisions were made, where things were left off, and what the immediate next step is.

Structure the summary to consistently capture:
1. What the conversation is about: High-level overview of the user's primary goal, topic, or architectural focus.
2. What was completed: Key technical decisions, implementations, answers provided, or milestones accomplished.
3. Where we stopped: Exact current state of progress and where the discussion or work left off.
4. Next step: Immediate next action, pending question, or recommended next implementation step.

Rules:
1. Focus ONLY on topics and decisions actively discussed by the user in this conversation, technical decisions made, code/architecture discussed, user goals, and current progress. Do not incorporate background user preferences, facts, or technologies merely cited by the assistant unless actively discussed in this dialogue.
2. Explicitly cover all 4 areas: what the conversation is about, what was completed, where we stopped, and the next step.
3. Keep the summary concise (under 250 words / 1500 characters).
4. Do NOT include filler, conversational pleasantries, internal IDs, or secrets.
5. Write in clear, structured bullet points.`;

const inFlightSummarizations = new Set<string>();

export const getInFlightSummarizationCount = (): number => {
  return inFlightSummarizations.size;
};

export const shouldSummarizeConversation = (
  messageCount: number,
  lastSummarizedMessageCount: number = 0,
): boolean => {
  if (messageCount < MIN_MESSAGES_FOR_SUMMARY) {
    return false;
  }
  if (lastSummarizedMessageCount === 0) {
    return true;
  }
  return messageCount - lastSummarizedMessageCount >= SUMMARY_TRIGGER_INTERVAL;
};

export const summarizeConversation = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
  customProvider?: AIProvider,
): Promise<string | null> => {
  const convIdStr = conversationId.toString();
  const userIdStr = userId.toString();

  // Guard against concurrent duplicate runs
  if (inFlightSummarizations.has(convIdStr)) {
    return null;
  }

  inFlightSummarizations.add(convIdStr);

  try {
    const conversation =
      await conversationRepository.findConversationByIdAndUserId(
        convIdStr,
        userIdStr,
      );

    if (!conversation) {
      return null;
    }

    const lastSummarized = conversation.lastSummarizedMessageCount ?? 0;

    // Fetch total count of completed messages for this conversation
    const totalCompletedCount = await Message.countDocuments({
      conversationId: conversation._id,
      status: MESSAGE_STATUSES.COMPLETED,
    });

    if (totalCompletedCount === 0) {
      return null;
    }

    // Determine if incremental update is applicable:
    // Requires an existing summary, a positive lastSummarizedMessageCount,
    // and totalCompletedCount >= lastSummarizedMessageCount.
    const isIncremental = Boolean(
      conversation.summary &&
      conversation.summary.trim().length > 0 &&
      lastSummarized > 0 &&
      totalCompletedCount >= lastSummarized,
    );

    // If incremental and no new completed messages have arrived, return existing summary safely
    if (isIncremental && totalCompletedCount === lastSummarized) {
      return conversation.summary ?? null;
    }

    // Fetch messages to summarize:
    // In incremental mode, skip previously summarized messages and fetch only new dialogue turns.
    // Otherwise, fetch all completed messages.
    let messages = await Message.find({
      conversationId: conversation._id,
      status: MESSAGE_STATUSES.COMPLETED,
    })
      .sort({ createdAt: 1 })
      .skip(isIncremental ? lastSummarized : 0)
      .lean();

    // Fallback: if incremental skip yielded no messages but totalCompletedCount > 0, fetch all completed messages
    if (messages.length === 0) {
      if (isIncremental && conversation.summary) {
        return conversation.summary ?? null;
      }
      messages = await Message.find({
        conversationId: conversation._id,
        status: MESSAGE_STATUSES.COMPLETED,
      })
        .sort({ createdAt: 1 })
        .lean();
    }

    if (messages.length === 0) {
      return null;
    }

    const provider =
      customProvider ?? orchestratorService.getDefaultProvider();

    // Format transcript turns safely
    const formattedTranscript = messages
      .map((m) => {
        const roleLabel =
          m.role === MESSAGE_ROLES.USER ? "User" : "Assistant";
        const cleanContent = m.content.replace(/\s+/g, " ").trim();
        return `${roleLabel}: ${cleanContent}`;
      })
      .join("\n");

    const promptMessages: AIMessage[] = [
      {
        role: "system",
        content: SUMMARIZATION_SYSTEM_PROMPT,
      },
    ];

    if (isIncremental && conversation.summary) {
      promptMessages.push({
        role: "user",
        content: `Previous conversation summary:\n${conversation.summary}\n\nNew dialogue turns to incorporate into an updated summary:\n${formattedTranscript}\n\nPlease generate an updated, concise summary preserving key context. Ensure the summary consistently captures:\n- What the conversation is about\n- What was completed\n- Where we stopped\n- Next step`,
      });
    } else {
      promptMessages.push({
        role: "user",
        content: `Please summarize the following conversation dialogue turns into a concise summary capturing:\n- What the conversation is about\n- What was completed\n- Where we stopped\n- Next step\n\nDialogue turns:\n${formattedTranscript}`,
      });
    }

    const response = await provider.generateChatResponse(promptMessages, {
      maxTokens: 400,
    });

    const summaryText = response.content?.trim();
    if (!summaryText) {
      return null;
    }

    // Truncate to MAX_SUMMARY_CHARS
    const cleanSummary = summaryText.slice(0, MAX_SUMMARY_CHARS).trim();

    // Atomically persist to MongoDB
    await conversationRepository.updateConversationSummary(
      conversation._id,
      userIdStr,
      cleanSummary,
      totalCompletedCount,
    );

    return cleanSummary;
  } catch (err) {
    console.warn("Non-fatal error during conversation summarization:", err);
    return null;
  } finally {
    inFlightSummarizations.delete(convIdStr);
  }
};

export const summarizeConversationIfNeeded = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
  customProvider?: AIProvider,
): Promise<string | null> => {
  try {
    const conversation =
      await conversationRepository.findConversationByIdAndUserId(
        conversationId,
        userId,
      );

    if (!conversation) {
      return null;
    }

    const messageCount = conversation.messageCount ?? 0;
    const lastSummarized = conversation.lastSummarizedMessageCount ?? 0;

    if (!shouldSummarizeConversation(messageCount, lastSummarized)) {
      return null;
    }

    return await summarizeConversation(conversationId, userId, customProvider);
  } catch (err) {
    console.warn(
      "Non-fatal check error in summarizeConversationIfNeeded:",
      err,
    );
    return null;
  }
};
