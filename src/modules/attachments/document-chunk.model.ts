import { Schema, model, type Types } from "mongoose";

export interface IDocumentChunk {
  _id: Types.ObjectId;
  attachmentId: Types.ObjectId;
  chunkIndex: number;
  text: string;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

const documentChunkSchema = new Schema<IDocumentChunk>(
  {
    attachmentId: {
      type: Schema.Types.ObjectId,
      ref: "Attachment",
      required: true,
      index: true,
    },

    chunkIndex: {
      type: Number,
      required: true,
    },

    text: {
      type: String,
      required: true,
      trim: true,
    },

    embedding: {
      type: [Number],
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound unique index ensuring deterministic ordering and strict duplicate protection
documentChunkSchema.index({ attachmentId: 1, chunkIndex: 1 }, { unique: true });

export const DocumentChunk = model<IDocumentChunk>("DocumentChunk", documentChunkSchema);
export const DocumentChunkModel = DocumentChunk;
