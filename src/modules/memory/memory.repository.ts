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

