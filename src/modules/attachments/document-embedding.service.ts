import { Types } from "mongoose";
import { AppError } from "../../errors/app.error.js";
import type { EmbeddingProvider } from "../ai/providers/embedding-provider.interface.js";
import { OllamaEmbeddingProvider } from "../ai/providers/ollama-embedding.provider.js";
import {
  ATTACHMENT_STATUSES,
  ATTACHMENT_TYPES,
  type IAttachment,
} from "./attachment.types.js";
import { chunkAttachment, type ChunkingOptions } from "./document-chunking.service.js";
import { type IDocumentChunk } from "./document-chunk.model.js";
import * as documentChunkRepository from "./document-chunk.repository.js";
import * as attachmentRepository from "./attachment.repository.js";

let defaultEmbeddingProvider: EmbeddingProvider = new OllamaEmbeddingProvider();

export const setDefaultEmbeddingProvider = (provider: EmbeddingProvider): void => {
  defaultEmbeddingProvider = provider;
};

export const getDefaultEmbeddingProvider = (): EmbeddingProvider => {
  return defaultEmbeddingProvider;
};

export interface ProcessDocumentEmbeddingOptions {
  provider?: EmbeddingProvider | undefined;
  chunkingOptions?: ChunkingOptions | undefined;
}

export interface ProcessDocumentEmbeddingResult {
  success: boolean;
  attachmentId: string;
  chunkCount: number;
  chunks: IDocumentChunk[];
}

/**
 * Validates embedding vector dimensions and consistency:
 * - Must be a non-empty array of numbers
 * - Length must match expected dimensions
 * - All elements must be finite, valid numbers
 */
export const validateEmbeddingVector = (
  vector: number[],
  expectedDimensions?: number,
): void => {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new AppError(
      "Embedding provider returned an empty or invalid vector",
      502,
      "INVALID_EMBEDDING_VECTOR",
    );
  }

  if (expectedDimensions !== undefined && expectedDimensions > 0 && vector.length !== expectedDimensions) {
    throw new AppError(
      `Embedding dimension mismatch: expected ${expectedDimensions}, got ${vector.length}`,
      502,
      "INVALID_EMBEDDING_DIMENSIONS",
    );
  }

  for (let i = 0; i < vector.length; i++) {
    const val = vector[i];
    if (typeof val !== "number" || Number.isNaN(val) || !Number.isFinite(val)) {
      throw new AppError(
        `Embedding vector contains invalid numeric value at index ${i}`,
        502,
        "INVALID_EMBEDDING_VECTOR",
      );
    }
  }
};

/**
 * Processes embeddings for every chunk of a READY document:
 * 1. Checks attachment exists and is in READY status
 * 2. Chunks extracted document text using Step 13 chunker
 * 3. Generates embedding per chunk via configured embedding provider
 * 4. Validates vector dimensions and consistency
 * 5. Idempotently stores persistent chunk records (prevents duplicate records on reprocessing)
 * 6. Handles provider or dimension failure safely by marking attachment status as FAILED
 */
export const processDocumentEmbeddings = async (
  attachmentOrId: string | Types.ObjectId | IAttachment,
  options?: ProcessDocumentEmbeddingOptions,
): Promise<ProcessDocumentEmbeddingResult> => {
  let attachment: IAttachment | null;

  if (
    typeof attachmentOrId === "string" ||
    attachmentOrId instanceof Types.ObjectId ||
    (typeof attachmentOrId === "object" && !("extractedText" in attachmentOrId) && "_id" in attachmentOrId)
  ) {
    const id =
      typeof attachmentOrId === "object" && "_id" in attachmentOrId
        ? attachmentOrId._id
        : attachmentOrId;
    attachment = await attachmentRepository.findAttachmentById(id as any);
  } else {
    attachment = attachmentOrId as IAttachment;
  }

  if (!attachment) {
    throw new AppError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
  }

  const attachmentIdStr = attachment._id.toString();

  if (attachment.type !== ATTACHMENT_TYPES.DOCUMENT) {
    throw new AppError(
      "Only document attachments can be processed for embeddings",
      400,
      "INVALID_ATTACHMENT_TYPE",
    );
  }

  if (attachment.status !== ATTACHMENT_STATUSES.READY) {
    throw new AppError(
      `Cannot generate embeddings for attachment with status '${attachment.status}'. Only READY documents can be processed.`,
      400,
      "ATTACHMENT_NOT_READY",
    );
  }

  const provider = options?.provider ?? defaultEmbeddingProvider;
  const expectedDimensions = provider.dimensions;

  const rawText = attachment.extractedText ?? "";
  if (!rawText || rawText.trim().length === 0) {
    // Empty document: ensure no leftover chunks and return cleanly
    await documentChunkRepository.deleteDocumentChunksByAttachmentId(attachment._id);
    return {
      success: true,
      attachmentId: attachmentIdStr,
      chunkCount: 0,
      chunks: [],
    };
  }

  const docChunks = chunkAttachment(attachment, options?.chunkingOptions);
  if (docChunks.length === 0) {
    await documentChunkRepository.deleteDocumentChunksByAttachmentId(attachment._id);
    return {
      success: true,
      attachmentId: attachmentIdStr,
      chunkCount: 0,
      chunks: [],
    };
  }

  const recordsToInsert: Array<{
    attachmentId: Types.ObjectId;
    chunkIndex: number;
    text: string;
    embedding: number[];
  }> = [];

  try {
    for (let i = 0; i < docChunks.length; i++) {
      const chunk = docChunks[i]!;
      const vector = await provider.generateEmbedding(chunk.text);
      validateEmbeddingVector(vector, expectedDimensions);

      recordsToInsert.push({
        attachmentId: attachment._id,
        chunkIndex: chunk.chunkIndex ?? i,
        text: chunk.text,
        embedding: vector,
      });
    }

    // Idempotency guarantee: delete any previous chunks for this attachment before inserting new ones
    await documentChunkRepository.deleteDocumentChunksByAttachmentId(attachment._id);

    // Persist all chunk embedding records in deterministic order
    const createdChunks = await documentChunkRepository.createDocumentChunks(recordsToInsert);

    return {
      success: true,
      attachmentId: attachmentIdStr,
      chunkCount: createdChunks.length,
      chunks: createdChunks,
    };
  } catch (error: unknown) {
    // Safely mark processing failure using the existing attachment status error flow
    try {
      await attachmentRepository.updateAttachment(attachment._id, {
        status: ATTACHMENT_STATUSES.FAILED,
      });
      await documentChunkRepository.deleteDocumentChunksByAttachmentId(attachment._id);
    } catch (cleanupErr) {
      console.error(
        `Failed to mark attachment ${attachmentIdStr} as FAILED or clean chunks:`,
        cleanupErr,
      );
    }

    if (error instanceof AppError) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "Failed to generate document embeddings";
    throw new AppError(message, 502, "AI_PROVIDER_ERROR");
  }
};
