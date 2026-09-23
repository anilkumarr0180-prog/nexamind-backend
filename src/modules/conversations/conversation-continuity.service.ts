import type { Types } from "mongoose";
import * as conversationRepository from "./conversation.repository.js";
import { calculateTextRelevance } from "../memory/memory.repository.js";

export const DEFAULT_MAX_CONTINUITY_CONVERSATIONS = 2;
export const MAX_CONTINUITY_SUMMARY_CHARS = 1500;
export const MAX_CONTINUITY_CONTEXT_CHARS = 3000;

export const CONTINUITY_PATTERNS: RegExp[] = [
  /\b(?:do\s+you\s+)?remember\s+(?:what|where)\s+(?:we|i)\b/i,
  /\bwhat\s+(?:were\s+we|was\s+i|have\s+we\s+been|have\s+i\s+been)\s+(?:working\s+on|doing|building|talking\s+about|discussing)\b/i,
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
  /\b(?:okay\s*,?\s*|ok\s*,?\s*)?(?:let's|lets|can\s+we|shall\s+we)\s+continue\b/i,
  /\b(?:let's|lets|can\s+we|shall\s+we)\s+(?:continue|resume|pick\s+up)\b/i,
  /\bcontinue\s+(?:our\s+)?(?:previous|last|past)\s+(?:work|project|discussion|session)\b/i,
  /\bremind\s+me\s+(?:what|where)\s+(?:we|i)\b/i,
  /\bwhat\s+was\s+(?:our|my|the)\s+last\s+(?:discussion|topic|task|session|work)\b/i,
  /\b(?:in|from)\s+(?:our|the|my)?\s*(?:previous|last|past)\s+(?:conversation|session|chat)\b/i,
  /\b(?:previous|last|past)\s+(?:conversation|session|chat)\b/i,
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
  "session", "sessions", "conversation", "conversations", "chat", "chats", "convo",
  "project", "projects",
  "thing", "things",
  "completed", "complete", "finished", "finish", "accomplished",
  "time", "times", "task", "tasks", "topic", "topics", "plan", "plans",
  "can", "could", "would", "should", "tell", "say", "please", "the", "a", "an"
]);

/**
 * Extracts specific domain or topic keywords from a continuity query by stripping
 * conversational phrasing and continuity framing words.
 */
export const extractTopicKeywords = (query: string): string[] => {
  const clean = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = clean.split(" ").filter((w) => w.length > 1);
  return tokens.filter((t) => !CONTINUITY_FRAMING_WORDS.has(t));
};

/**
 * Checks if a user's prompt is a cross-conversation continuity request.
 */
export const isContinuityRequest = (query?: string | null): boolean => {
  if (!query || typeof query !== "string") {
    return false;
  }
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return CONTINUITY_PATTERNS.some((pattern) => pattern.test(trimmed));
};

export interface ContinuityContextOptions {
  userId: string | Types.ObjectId;
  currentConversationId?: string | Types.ObjectId;
  userQuery?: string | null;
  limit?: number;
}

/**
 * Retrieves and formats the most relevant previous conversation summaries for the user
 * when a continuity request is detected.
 */
export const getContinuityContextForUser = async (
  options: ContinuityContextOptions,
): Promise<string | null> => {
  const {
    userId,
    currentConversationId,
    userQuery,
    limit = DEFAULT_MAX_CONTINUITY_CONVERSATIONS,
  } = options;

  if (!userId || !isContinuityRequest(userQuery)) {
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

