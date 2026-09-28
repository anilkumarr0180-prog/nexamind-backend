import { Types } from "mongoose";
import { AppError } from "../../errors/app.error.js";
import { findConversationById } from "../conversations/conversation.repository.js";
import { Attachment } from "./attachment.model.js";
import {
  ATTACHMENT_STATUSES,
  ATTACHMENT_TYPES,
  DEFAULT_RAG_TOP_K,
  MAX_RAG_TOP_K,
  DEFAULT_RAG_SIMILARITY_THRESHOLD,
  type IAttachment,
} from "./attachment.types.js";
import {
  findDocumentChunksByAttachmentIds,
} from "./document-chunk.repository.js";
import {
  getDefaultEmbeddingProvider,
  validateEmbeddingVector,
} from "./document-embedding.service.js";
import type { EmbeddingProvider } from "../ai/providers/embedding-provider.interface.js";

export const DEFAULT_DOCUMENT_SEARCH_LIMIT = DEFAULT_RAG_TOP_K;
export const DEFAULT_DOCUMENT_SIMILARITY_THRESHOLD = DEFAULT_RAG_SIMILARITY_THRESHOLD;

export interface SemanticDocumentSearchInput {
  userId: string | Types.ObjectId;
  query: string;
  conversationId?: string | Types.ObjectId | undefined;
  attachmentId?: string | Types.ObjectId | undefined;
  attachmentIds?: Array<string | Types.ObjectId> | undefined;
  limit?: number | undefined;
  minSimilarity?: number | undefined;
  provider?: EmbeddingProvider | undefined;
}

export interface RelevantDocumentChunk {
  attachmentId: string;
  chunkIndex: number;
  text: string;
  similarity: number;
  score: number;
  documentName?: string | undefined;
}

export interface DocumentSearchResult {
  success: boolean;
  query: string;
  totalChunksSearched: number;
  results: RelevantDocumentChunk[];
}

/**
 * Calculates standard cosine similarity between two numeric vectors.
 * Returns 0 if either vector is empty, mismatched in length, or zero-magnitude.
 */
export const calculateCosineSimilarity = (a: number[], b: number[]): number => {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
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

/**
 * Verifies authenticated user access to a conversation.
 */
export const verifyConversationAccess = async (
  userId: string,
  conversationId: string,
) => {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const trimmedConversationId = conversationId?.trim();
  if (!trimmedConversationId) {
    throw new AppError("Conversation ID is required", 400, "INVALID_INPUT");
  }

  const conversation = await findConversationById(trimmedConversationId);
  if (!conversation) {
    throw new AppError("Conversation not found", 404, "CONVERSATION_NOT_FOUND");
  }

  if (conversation.userId.toString() !== trimmedUserId) {
    throw new AppError(
      "Conversation does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  return conversation;
};

/**
 * Verifies authenticated user access to an attachment.
 */
export const verifyAttachmentAccess = async (
  userId: string,
  attachmentId: string,
  conversationId?: string,
): Promise<IAttachment> => {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const trimmedAttachmentId = attachmentId?.trim();
  if (!trimmedAttachmentId) {
    throw new AppError("Attachment ID is required", 400, "INVALID_INPUT");
  }

  const attachment = await Attachment.findById(trimmedAttachmentId);
  if (!attachment) {
    throw new AppError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
  }

  if (attachment.userId.toString() !== trimmedUserId) {
    throw new AppError(
      "Attachment does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  const trimmedConversationId = conversationId?.trim();
  if (
    trimmedConversationId &&
    attachment.conversationId.toString() !== trimmedConversationId
  ) {
    throw new AppError(
      "Attachment does not belong to the specified conversation",
      400,
      "INVALID_ATTACHMENT_CONVERSATION",
    );
  }

  return attachment;
};

/**
 * Executes semantic document search across stored chunk embeddings:
 * 1. Strictly scopes and verifies conversation / attachment ownership for the user
 * 2. Fetches stored chunk embeddings for allowed documents
 * 3. Generates embedding for the user's query text via the existing provider
 * 4. Computes cosine similarity between query vector and stored chunk vectors
 * 5. Filters by minSimilarity threshold and returns top K ranked chunks deterministically
 */
export const semanticDocumentSearch = async (
  input: SemanticDocumentSearchInput,
): Promise<DocumentSearchResult> => {
  const userIdStr = input.userId ? String(input.userId).trim() : "";
  if (!userIdStr) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const trimmedQuery = input.query?.trim() ?? "";
  if (!trimmedQuery) {
    return {
      success: true,
      query: "",
      totalChunksSearched: 0,
      results: [],
    };
  }

  const userObjectId = new Types.ObjectId(userIdStr);
  let conversationObjectId: Types.ObjectId | undefined;
  const conversationIdStr = input.conversationId
    ? String(input.conversationId).trim()
    : undefined;

  if (conversationIdStr) {
    await verifyConversationAccess(userIdStr, conversationIdStr);
    conversationObjectId = new Types.ObjectId(conversationIdStr);
  }

  // Resolve target attachments based on explicit attachmentId, attachmentIds, or conversation scope
  const targetAttachmentIds: Types.ObjectId[] = [];
  const attachmentNameMap = new Map<string, string>();

  if (input.attachmentId) {
    const singleIdStr = String(input.attachmentId).trim();
    const att = await verifyAttachmentAccess(
      userIdStr,
      singleIdStr,
      conversationIdStr,
    );
    if (
      att.type === ATTACHMENT_TYPES.DOCUMENT &&
      att.status === ATTACHMENT_STATUSES.READY
    ) {
      targetAttachmentIds.push(att._id);
      attachmentNameMap.set(att._id.toString(), att.originalName);
    }
  } else if (input.attachmentIds && input.attachmentIds.length > 0) {
    for (const rawId of input.attachmentIds) {
      const idStr = String(rawId).trim();
      const att = await verifyAttachmentAccess(
        userIdStr,
        idStr,
        conversationIdStr,
      );
      if (
        att.type === ATTACHMENT_TYPES.DOCUMENT &&
        att.status === ATTACHMENT_STATUSES.READY
      ) {
        targetAttachmentIds.push(att._id);
        attachmentNameMap.set(att._id.toString(), att.originalName);
      }
    }
  } else {
    // Search all READY document attachments belonging to this user (optionally scoped to conversation)
    const filter: Record<string, unknown> = {
      userId: userObjectId,
      type: ATTACHMENT_TYPES.DOCUMENT,
      status: ATTACHMENT_STATUSES.READY,
    };
    if (conversationObjectId) {
      filter.conversationId = conversationObjectId;
    }

    const docs = await Attachment.find(filter).select("_id originalName").lean();
    for (const doc of docs) {
      const attId = doc._id as Types.ObjectId;
      targetAttachmentIds.push(attId);
      if (doc.originalName) {
        attachmentNameMap.set(attId.toString(), doc.originalName);
      }
    }
  }

  // If no eligible documents found in this scope, return empty result safely
  if (targetAttachmentIds.length === 0) {
    return {
      success: true,
      query: trimmedQuery,
      totalChunksSearched: 0,
      results: [],
    };
  }

  // Retrieve stored chunk embeddings for allowed documents
  const storedChunks = await findDocumentChunksByAttachmentIds(targetAttachmentIds);
  if (storedChunks.length === 0) {
    return {
      success: true,
      query: trimmedQuery,
      totalChunksSearched: 0,
      results: [],
    };
  }

  // Generate query embedding using existing embedding provider
  const provider = input.provider ?? getDefaultEmbeddingProvider();
  const queryVector = await provider.generateEmbedding(trimmedQuery);
  validateEmbeddingVector(queryVector, provider.dimensions);

  const minSimilarity =
    input.minSimilarity !== undefined
      ? input.minSimilarity
      : DEFAULT_DOCUMENT_SIMILARITY_THRESHOLD;
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_DOCUMENT_SEARCH_LIMIT, 50));

  const scored: RelevantDocumentChunk[] = [];

  for (const chunk of storedChunks) {
    if (chunk.embedding && Array.isArray(chunk.embedding) && chunk.embedding.length > 0) {
      const similarity = calculateCosineSimilarity(queryVector, chunk.embedding);
      if (similarity >= minSimilarity) {
        scored.push({
          attachmentId: chunk.attachmentId.toString(),
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          similarity,
          score: similarity,
          documentName: attachmentNameMap.get(chunk.attachmentId.toString()),
        });
      }
    }
  }

  // Deterministic ranking:
  // 1. Similarity score descending
  // 2. attachmentId ascending (deterministic tie-breaker)
  // 3. chunkIndex ascending (deterministic tie-breaker)
  scored.sort((a, b) => {
    if (b.similarity !== a.similarity) {
      return b.similarity - a.similarity;
    }
    const attCmp = a.attachmentId.localeCompare(b.attachmentId);
    if (attCmp !== 0) {
      return attCmp;
    }
    return a.chunkIndex - b.chunkIndex;
  });

  const topResults = scored.slice(0, limit);

  return {
    success: true,
    query: trimmedQuery,
    totalChunksSearched: storedChunks.length,
    results: topResults,
  };
};

/**
 * Convenient alias that returns the top relevant chunks array directly.
 */
export const searchDocumentChunks = async (
  input: SemanticDocumentSearchInput,
): Promise<RelevantDocumentChunk[]> => {
  const result = await semanticDocumentSearch(input);
  return result.results;
};
