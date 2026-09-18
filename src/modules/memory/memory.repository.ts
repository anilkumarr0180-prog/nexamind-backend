import { Types } from "mongoose";
import {
  Memory,
  MEMORY_STATUSES,
  type MemoryStatus,
  type MemoryType,
} from "./memory.model.js";

export type CreateMemoryData = {
  userId: string | Types.ObjectId;
  type: MemoryType;
  content: string;
  embedding?: number[] | undefined;
  status?: MemoryStatus;
  deletedAt?: Date | null;
};

export type UpdateMemoryData = {
  type?: MemoryType;
  content?: string;
  embedding?: number[] | undefined;
};

export type FindActiveMemoriesOptions = {
  type?: MemoryType | undefined;
  limit?: number | undefined;
};

export type VectorSearchOptions = {
  limit?: number | undefined;
  minScore?: number | undefined;
};

export type VectorSearchResult = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: MemoryType;
  content: string;
  status: MemoryStatus;
  createdAt: Date;
  score?: number;
};

export const createMemory = async (data: CreateMemoryData) => {
  return Memory.create({
    ...data,
    status: MEMORY_STATUSES.ACTIVE,
    deletedAt: null,
  });
};

export const findMemoryByIdAndUserId = async (
  memoryId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
) => {
  return Memory.findOne({
    _id: memoryId,
    userId,
    status: MEMORY_STATUSES.ACTIVE,
  });
};

export const findActiveMemoriesByUserId = async (
  userId: string | Types.ObjectId,
  options?: FindActiveMemoriesOptions,
) => {
  const filter: Record<string, unknown> = {
    userId,
    status: MEMORY_STATUSES.ACTIVE,
  };

  if (options?.type) {
    filter.type = options.type;
  }

  let query = Memory.find(filter).sort({ createdAt: -1, _id: -1 });

  if (options?.limit !== undefined && options.limit > 0) {
    query = query.limit(options.limit);
  }

  return query;
};

export const updateMemory = async (
  memoryId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
  data: UpdateMemoryData,
) => {
  return Memory.findOneAndUpdate(
    {
      _id: memoryId,
      userId,
      status: MEMORY_STATUSES.ACTIVE,
    },
    data,
    { returnDocument: "after" },
  );
};

export const softDeleteMemory = async (
  memoryId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
) => {
  return Memory.findOneAndUpdate(
    {
      _id: memoryId,
      userId,
      status: MEMORY_STATUSES.ACTIVE,
    },
    {
      status: MEMORY_STATUSES.DELETED,
      deletedAt: new Date(),
    },
    { returnDocument: "after" },
  );
};

const calculateCosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

export const searchActiveMemoriesByVector = async (
  userId: string | Types.ObjectId,
  queryVector: number[],
  options?: VectorSearchOptions,
): Promise<VectorSearchResult[]> => {
  const userObjectId =
    typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const limit = Math.max(1, options?.limit ?? 10);
  const numCandidates = Math.max(limit * 10, 50);

  try {
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: "memory_vector_index",
          path: "embedding",
          queryVector,
          numCandidates,
          limit,
          filter: {
            userId: userObjectId,
            status: MEMORY_STATUSES.ACTIVE,
          },
        },
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          type: 1,
          content: 1,
          status: 1,
          createdAt: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];

    if (options?.minScore !== undefined) {
      pipeline.push({
        $match: {
          score: { $gte: options.minScore },
        },
      });
    }

    const results = await Memory.aggregate<VectorSearchResult>(pipeline);
    if (results && results.length > 0) {
      return results;
    }
  } catch (error: any) {
    // If Atlas vectorSearch is unavailable (e.g. in-memory test runner or unsupported local mongod),
    // we log an informational message and perform an in-memory cosine fallback below
    const isUnsupported =
      error?.message?.includes("$vectorSearch") ||
      error?.codeName === "Location40324" ||
      error?.message?.includes("index not found") ||
      error?.code === 40324;

    if (!isUnsupported) {
      console.warn("Vector search error:", error?.message || error);
    }
  }

  // Fallback / In-Memory Similarity computation (for test suites or non-Atlas environments)
  const activeUserMemories = await Memory.find({
    userId: userObjectId,
    status: MEMORY_STATUSES.ACTIVE,
    embedding: { $exists: true, $ne: null },
  })
    .select("+embedding")
    .lean();

  const scored: VectorSearchResult[] = [];
  for (const doc of activeUserMemories) {
    if (doc.embedding && Array.isArray(doc.embedding) && doc.embedding.length > 0) {
      const sim = calculateCosineSimilarity(queryVector, doc.embedding);
      if (options?.minScore === undefined || sim >= options.minScore) {
        scored.push({
          _id: doc._id as Types.ObjectId,
          userId: doc.userId as Types.ObjectId,
          type: doc.type,
          content: doc.content,
          status: doc.status,
          createdAt: doc.createdAt,
          score: sim,
        });
      }
    }
  }

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, limit);
};


export type TextSearchOptions = {
  limit?: number | undefined;
  minScore?: number | undefined;
};

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "down", "during",
  "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "ll",
  "m", "me", "might", "more", "most", "my", "myself",
  "no", "nor", "not", "now",
  "o", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "re",
  "s", "same", "shan", "she", "should", "so", "some", "such",
  "t", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up",
  "ve", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "won", "would",
  "y", "you", "your", "yours", "yourself", "yourselves",
  "okay", "ok", "hey", "hi", "hello", "please", "tell", "say", "know", "think", "remember",
  "last", "past", "previous", "recent", "conversation", "convo", "chat", "session", "talk", "dialogue", "something", "anything"
]);

const WEAK_MODIFIERS = new Set([
  "favorite", "favourite", "prefer", "preferred", "preference", "preferences",
  "use", "uses", "using", "used",
  "learn", "learns", "learning",
  "work", "works", "working",
  "am", "is", "are"
]);

const normalizeAndTokenize = (text: string): string[] => {
  const clean = text
    .toLowerCase()
    .replace(/node\.js/g, "nodejs")
    .replace(/c\+\+/g, "cpp")
    .replace(/c\#/g, "csharp")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean.split(" ").filter((w) => w.length > 1);
};

const stemWord = (word: string): string => {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("es")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.endsWith("ing")) return word.slice(0, -3);
  if (word.endsWith("ed")) return word.slice(0, -2);
  return word;
};

export const calculateTextRelevance = (
  query: string,
  memoryContent: string,
): number => {
  const rawQueryTokens = normalizeAndTokenize(query);
  const meaningfulQueryTokens = rawQueryTokens.filter((t) => !STOP_WORDS.has(t));
  if (meaningfulQueryTokens.length === 0) return 0;

  const memTokens = normalizeAndTokenize(memoryContent);
  if (memTokens.length === 0) return 0;

  const memSet = new Set(memTokens);
  const memStems = new Set(memTokens.map(stemWord));

  let strongMatches = 0;
  let weakMatches = 0;
  let strongQueryCount = 0;
  let totalScore = 0;

  for (const qToken of meaningfulQueryTokens) {
    const isWeak = WEAK_MODIFIERS.has(qToken);
    if (!isWeak) {
      strongQueryCount++;
    }

    const qStem = stemWord(qToken);
    let matched = false;
    let matchScore = 0;

    if (memSet.has(qToken)) {
      matched = true;
      matchScore = isWeak ? 0.5 : 1.0;
    } else if (memStems.has(qStem)) {
      matched = true;
      matchScore = isWeak ? 0.4 : 0.85;
    } else {
      if (qToken.startsWith("tech") && memTokens.some((t) => t.startsWith("tech"))) {
        matched = true;
        matchScore = 0.85;
      }
    }

    if (matched) {
      if (isWeak) weakMatches++;
      else strongMatches++;
      totalScore += matchScore;
    }
  }

  // Strict specificity guard: If the query specified strong entity tokens
  // but zero strong entity tokens matched, do not match on weak modifiers alone
  if (strongQueryCount > 0 && strongMatches === 0) {
    return 0;
  }

  return totalScore / meaningfulQueryTokens.length;
};

export const searchActiveMemoriesByTextRelevance = async (
  userId: string | Types.ObjectId,
  query: string,
  options?: TextSearchOptions,
): Promise<VectorSearchResult[]> => {
  const userObjectId =
    typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const limit = Math.max(1, options?.limit ?? 10);
  const minScore = options?.minScore ?? 0.25;

  const activeUserMemories = await Memory.find({
    userId: userObjectId,
    status: MEMORY_STATUSES.ACTIVE,
    deletedAt: null,
  }).lean();

  if (!activeUserMemories || activeUserMemories.length === 0) {
    return [];
  }

  const scored: VectorSearchResult[] = [];
  for (const doc of activeUserMemories) {
    const sim = calculateTextRelevance(query, doc.content);
    if (sim >= minScore) {
      scored.push({
        _id: doc._id as Types.ObjectId,
        userId: doc.userId as Types.ObjectId,
        type: doc.type,
        content: doc.content,
        status: doc.status,
        createdAt: doc.createdAt,
        score: sim,
      });
    }
  }

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, limit);
};
