import type { Types } from "mongoose";
import * as conversationRepository from "./conversation.repository.js";
import { calculateTextRelevance } from "../memory/memory.repository.js";

import type { AIProvider } from "../ai/providers/ai-provider.interface.js";

export const DEFAULT_MAX_CONTINUITY_CONVERSATIONS = 2;
export const MAX_CONTINUITY_SUMMARY_CHARS = 1500;
export const MAX_CONTINUITY_CONTEXT_CHARS = 3000;

export const normalizeContinuityText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[\x27\x60\u2019]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(?:remebr|remeber|rember|remembr)\b/g, "remember")
    .replace(/\b(?:disscusedd|disscus|disscuss)\b/g, "discuss")
    .replace(/\b(?:disscussed|disscused)\b/g, "discussed")
    .replace(/\b(?:convo|convos|converstation|conversaton)\b/g, "conversation")
    .replace(/\b(?:last|past|previous)\s+char\b/g, "$1 chat")
    .trim();
};

export const CONTINUITY_PATTERNS: RegExp[] = [
  /\bremember\b.*\b(?:what|where)\s+(?:we|i)\b/i,
  /\bremember\b.*\b(?:talking|discussing|working|learning)\b/i,
  /\bremember\b.*\b(?:last|previous|past|prior)\b/i,
  /\b(?:do\s+you\s+)?remember\s+(?:our\s+|my\s+|the\s+)?(?:last|previous|past)?\s*(?:conversation|conversations|session|sessions|chat|chats)\b/i,
  /\brecall\b.*\b(?:conversation|chat|session|last|previous|past|what|where)\b/i,
  /\bwhat\s+(?:were\s+we|was\s+i|have\s+we\s+been|have\s+i\s+been|did\s+we|are\s+we|we\s+are|we\s+were)\s+(?:working\s+on|doing|building|talking\s+about|discussing|learning)\b/i,
  /\bwhat\s+(?:did\s+(?:we|i)|have\s+we\s+done|have\s+i\s+done)\s+(?:work\s+on|do|build|done)\b/i,
  /\bwhat\s+did\s+(?:we|i)\s+(?:discuss|talk\s+about|cover|decide)\b/i,
  /\bwhere\s+did\s+(?:we|i)\s+(?:stop|leave\s+off|end|finish)\b/i,
  /\bwhere\s+(?:we|i)\s+(?:left\s+off|stopped)\b/i,
  /\bwhat\s+(?:was|were)\s+(?:the|our)\s+next\s+steps?\b/i,
  /\bwhat\s+(?:were|was|are)\s+(?:our|my|the)\s+(?:recent|last|past)\s+(?:projects?|tasks?|topics?|discussions?|sessions?|work)\b/i,
  /\b(?:last\s+thing\s+(?:we|i)\s+(?:were\s+working\s+on|worked\s+on|did)|what\s+was\s+(?:the\s+)?last\s+thing)\b/i,
  /\bwhat\s+should\s+(?:we|i)\s+(?:continue|work\s+on|do\s+next)\b/i,
  /\bwhat\s+(?:can|to)\s+continue\b/i,
  /\bwhat\s+was\s+(?:completed|done|accomplished|finished)\b/i,
  /\bcontinue\s+(?:from\s+)?where\s+(?:we|i)\s+(?:left\s+off|stopped)\b/i,
  /\bpick\s+up\s+(?:from\s+)?where\s+(?:we|i)\s+(?:left\s+off|stopped)\b/i,
  /\b(?:okay\s*,?\s*|ok\s*,?\s*)?(?:lets|let\s*s|can\s+we|shall\s+we)\s+continue\b/i,
  /\b(?:lets|let\s*s|can\s+we|shall\s+we)\s+(?:continue|resume|pick\s+up)\b/i,
  /\bcontinue\s+(?:our\s+)?(?:previous|last|past)\s+(?:work|project|discussion|session|conversation|chat)\b/i,
  /\bremind\s+me\s+(?:about\s+)?(?:our|my|the)?\s*(?:last|previous|past)?\s*(?:conversation|conversations|session|sessions|chat|chats)\b/i,
  /\bremind\s+me\s+(?:what|where)\s+(?:we|i)\b/i,
  /\bwhat\s+was\s+(?:our|my|the)\s+last\s+(?:discussion|topic|task|session|work)\b/i,
  /\b(?:in|from)\s+(?:our|the|my)?\s*(?:previous|last|past)\s+(?:conversation|conversations|session|sessions|chat|chats)\b/i,
  /\b(?:previous|last|past)\s+(?:conversation|conversations|session|sessions|chat|chats)\b/i,
  /\b(?:what|where)\s+(?:did\s+(?:we|i)|were\s+we|was\s+i|have\s+we|have\s+i).*\b(?:yesterday|last\s+time|before|previously|earlier|recently|lately)\b/i,
];

const CONTINUITY_FRAMING_WORDS = new Set([
  "do", "you", "remember", "recall", "what", "where", "which", "who", "when", "why", "how",
  "did", "were", "was", "is", "are", "am", "be", "been", "being",
  "have", "has", "had",
  "we", "i", "our", "my", "us", "me", "your", "yours",
  "work", "worked", "working", "works",
  "done", "doing",
  "build", "built", "building",
  "discuss", "discussed", "discussing", "discussion", "discussions",
  "talk", "talked", "talking",
  "cover", "covered", "covering",
  "decide", "decided", "deciding",
  "stop", "stopped", "stopping",
  "leave", "left",
  "off", "on", "in", "from", "at", "to", "for", "with", "about",
  "continue", "pick", "up", "resume",
  "let", "lets", "ok", "okay", "shall",
  "remind",
  "next", "step", "steps",
  "last", "past", "previous", "prior", "recent", "recently", "lately", "latest", "earlier", "before", "previously", "yesterday", "today",
  "session", "sessions", "conversation", "conversations", "chat", "chats", "convo", "convos",
  "project", "projects",
  "thing", "things",
  "completed", "complete", "finished", "finish", "accomplished",
  "time", "times", "task", "tasks", "topic", "topics", "plan", "plans",
  "can", "could", "would", "should", "tell", "say", "please", "the", "a", "an",
  "hey", "hi", "hello", "bro", "dude", "assistant", "nexamind", "ai", "bot",
  "just", "now", "also", "again", "so", "well", "like",
  "learn", "learned", "learning", "learnign"
]);

/**
 * Extracts specific domain or topic keywords from a continuity query by stripping
 * conversational phrasing and continuity framing words.
 */
export const extractTopicKeywords = (query: string): string[] => {
  const norm = normalizeContinuityText(query);
  const tokens = norm.split(" ").filter((w) => w.length > 1);
  return tokens.filter((t) => !CONTINUITY_FRAMING_WORDS.has(t));
};

/**
 * Checks if a user\x27s prompt is a cross-conversation continuity request.
 */
export const isContinuityRequest = (query?: string | null): boolean => {
  if (!query || typeof query !== "string") {
    return false;
  }
  const normalized = normalizeContinuityText(query);
  if (!normalized) {
    return false;
  }
  return CONTINUITY_PATTERNS.some((pattern) => pattern.test(normalized));
};

export interface ContinuityContextOptions {
  userId: string | Types.ObjectId;
  currentConversationId?: string | Types.ObjectId | undefined;
  userQuery?: string | null | undefined;
  limit?: number | undefined;
  customProvider?: AIProvider | undefined;
  recentMessages?: Array<{ role: string; content: string }> | undefined;
}

/**
 * Retrieves and formats the most relevant previous conversation summaries for the user
 * when a continuity request is detected or clarified.
 */
export const getContinuityContextForUser = async (
  options: ContinuityContextOptions,
): Promise<string | null> => {
  const {
    userId,
    currentConversationId,
    userQuery,
    limit = DEFAULT_MAX_CONTINUITY_CONVERSATIONS,
    customProvider,
    recentMessages,
  } = options;

  let effectiveContinuity = isContinuityRequest(userQuery);

  // If current prompt is not an explicit continuity request, check if it is a follow-up answer
  // to a previous continuity inquiry in the same conversation (e.g. user clarifying the topic).
  if (!effectiveContinuity && recentMessages && recentMessages.length >= 2) {
    const prevUserMsg = recentMessages[recentMessages.length - 2];
    const prevAssistantMsg = recentMessages[recentMessages.length - 1];

    const prevUserWasContinuity = prevUserMsg && isContinuityRequest(prevUserMsg.content);
    const prevAssistantAskedClarification =
      prevAssistantMsg &&
      /\b(?:previous\s+conversation|prior\s+conversation|record\s+of|pick\s+up\s+on|which\s+conversation|what\s+topic)\b/i.test(
        prevAssistantMsg.content,
      );

    if (prevUserWasContinuity || prevAssistantAskedClarification) {
      effectiveContinuity = true;
    }
  }

  if (!userId || !effectiveContinuity) {
    return null;
  }

  // Fetch candidate pool to evaluate relevance with fail-open protection
  let summarizedConversations: Awaited<
    ReturnType<typeof conversationRepository.findRecentSummarizedConversationsByUserId>
  >;
  try {
    const candidatePoolLimit = Math.max(limit * 25, 50);
    summarizedConversations =
      await conversationRepository.findRecentSummarizedConversationsByUserId(
        userId,
        currentConversationId,
        candidatePoolLimit,
      );
  } catch (convErr) {
    console.warn(
      "Non-fatal error retrieving recent summarized conversations for continuity:",
      convErr,
    );
    return null;
  }

  // On-demand summarization fallback: if the user has previous conversations with completed messages
  // that were not yet summarized (e.g. legacy or short 2-5 message conversations), summarize the most recent one.
  if (!summarizedConversations || summarizedConversations.length === 0) {
    try {
      const { Conversation } = await import("./conversation.model.js");
      const { summarizeConversation } = await import("./conversation-summary.service.js");
      const unsummarizedCandidate = await Conversation.findOne({
        userId,
        deletedAt: null,
        messageCount: { $gte: 2 },
        ...(currentConversationId ? { _id: { $ne: currentConversationId } } : {}),
      }).sort({ updatedAt: -1 });

      if (unsummarizedCandidate) {
        const summary = await summarizeConversation(
          unsummarizedCandidate._id,
          userId,
          customProvider,
        );
        if (summary) {
          summarizedConversations = [
            {
              _id: unsummarizedCandidate._id,
              userId: unsummarizedCandidate.userId,
              title: unsummarizedCandidate.title,
              summary,
              summaryUpdatedAt: new Date(),
              updatedAt: unsummarizedCandidate.updatedAt,
              deletedAt: null,
            } as any,
          ];
        }
      }
    } catch (fallbackErr) {
      console.warn(
        "Non-fatal error in on-demand summarization fallback for continuity:",
        fallbackErr,
      );
    }
  }

  if (!summarizedConversations || summarizedConversations.length === 0) {
    return null;
  }

  const currentIdStr = currentConversationId
    ? currentConversationId.toString()
    : null;
  const authUserIdStr = userId.toString();

  // Deduplicate and filter out deleted/invalid/current/cross-user conversations
  const validCandidates: typeof summarizedConversations = [];
  const seenConversationIds = new Set<string>();
  const seenSummaryTexts = new Set<string>();

  for (const conv of summarizedConversations) {
    if (!conv || !conv._id) continue;

    const convIdStr = conv._id.toString();

    // 1. Strictly exclude current conversation
    if (currentIdStr && convIdStr === currentIdStr) continue;

    // 2. Strictly exclude soft-deleted conversations
    if ((conv as { deletedAt?: Date | null }).deletedAt) continue;

    // 3. Defensive cross-user isolation verification
    const rawUserId = (conv as { userId?: unknown }).userId;
    const convUserIdStr =
      rawUserId && typeof rawUserId === "object" && "_id" in (rawUserId as Record<string, unknown>)
        ? String((rawUserId as { _id: unknown })._id)
        : rawUserId
          ? String(rawUserId)
          : null;
    if (convUserIdStr && convUserIdStr !== authUserIdStr) continue;

    // 4. Ignore missing, non-string, or empty/whitespace summaries
    if (!conv.summary || typeof conv.summary !== "string") continue;
    const trimmedSummary = conv.summary.trim();
    if (trimmedSummary.length === 0) continue;

    // 5. Deduplicate by conversation ID
    if (seenConversationIds.has(convIdStr)) continue;

    // 6. Deduplicate by normalized summary text
    const normalizedSummary = trimmedSummary.toLowerCase();
    if (seenSummaryTexts.has(normalizedSummary)) continue;

    seenConversationIds.add(convIdStr);
    seenSummaryTexts.add(normalizedSummary);
    validCandidates.push(conv);
  }

  if (validCandidates.length === 0) {
    return null;
  }

  // Check if user query contains topic-specific keywords beyond generic continuity framing
  const topicKeywords = extractTopicKeywords(userQuery ?? "");
  const hasTopicSpecificity = topicKeywords.length > 0;

  let selectedConversations = validCandidates;

  if (hasTopicSpecificity) {
    // Score each candidate against userQuery using existing calculateTextRelevance
    const scoredCandidates = validCandidates.map((conv) => {
      const titleScore = calculateTextRelevance(userQuery!, conv.title ?? "");
      const summaryScore = calculateTextRelevance(userQuery!, conv.summary!);
      const compositeScore = Math.max(
        titleScore,
        summaryScore,
        (titleScore * 1.5 + summaryScore) / 2,
      );
      return { conv, score: compositeScore };
    });

    // Filter by relevance threshold
    const relevantMatches = scoredCandidates
      .filter((item) => item.score >= 0.15)
      .sort((a, b) => b.score - a.score);

    if (relevantMatches.length === 0) {
      // Unrelated conversations are not unnecessarily selected when user asked for a specific topic
      return null;
    }

    selectedConversations = relevantMatches
      .slice(0, limit)
      .map((item) => item.conv);
  } else {
    // Generic continuity request (e.g. "where did we stop?", "what were we working on yesterday?")
    // Select the most recent conversation(s)
    selectedConversations = validCandidates.slice(0, limit);
  }

  const sections: string[] = [];
  let totalChars = 0;

  for (const conv of selectedConversations) {
    const title = conv.title?.trim() || "Previous conversation";
    let summaryText = conv.summary!.trim();

    // Enforce per-summary character cap
    if (summaryText.length > MAX_CONTINUITY_SUMMARY_CHARS) {
      summaryText = `${summaryText.slice(0, MAX_CONTINUITY_SUMMARY_CHARS)}... [truncated]`;
    }

    const section = `Previous conversation "${title}":\n${summaryText}`;

    // Enforce total historical context budget
    if (totalChars + section.length > MAX_CONTINUITY_CONTEXT_CHARS && sections.length > 0) {
      break;
    }

    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) {
    return null;
  }

  const instructions =
    "Resuming work guidance:\n" +
    "- Base your response on the above summary to clearly state: (1) what we were working on, (2) what was completed, (3) where the work stopped, and (4) what the next step was.\n" +
    "- If the summary does not contain a clear next step, state explicitly that the next step is not available on record instead of guessing or inventing progress.";

  return `Previous conversation context:\n${sections.join("\n\n")}\n\n${instructions}`;
};
