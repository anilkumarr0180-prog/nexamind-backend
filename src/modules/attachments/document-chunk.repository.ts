import type { Types } from "mongoose";
import { DocumentChunk, type IDocumentChunk } from "./document-chunk.model.js";

export interface CreateDocumentChunkData {
  attachmentId: Types.ObjectId | string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export const createDocumentChunks = async (
  chunks: CreateDocumentChunkData[],
): Promise<IDocumentChunk[]> => {
  if (chunks.length === 0) {
    return [];
  }
  const result = await DocumentChunk.insertMany(chunks as any, { ordered: true });
  return result as unknown as IDocumentChunk[];
};

export const findDocumentChunksByAttachmentId = async (
  attachmentId: Types.ObjectId | string,
): Promise<IDocumentChunk[]> => {
  return DocumentChunk.find({ attachmentId }).sort({ chunkIndex: 1 });
};

export const deleteDocumentChunksByAttachmentId = async (
  attachmentId: Types.ObjectId | string,
): Promise<{ deletedCount?: number }> => {
  return DocumentChunk.deleteMany({ attachmentId });
};

export const countDocumentChunksByAttachmentId = async (
  attachmentId: Types.ObjectId | string,
): Promise<number> => {
  return DocumentChunk.countDocuments({ attachmentId });
};

export const findDocumentChunksByAttachmentIds = async (
  attachmentIds: Array<Types.ObjectId | string>,
): Promise<IDocumentChunk[]> => {
  if (attachmentIds.length === 0) {
    return [];
  }
  return DocumentChunk.find({ attachmentId: { $in: attachmentIds } }).sort({
    attachmentId: 1,
    chunkIndex: 1,
  });
};

