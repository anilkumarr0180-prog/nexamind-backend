import { Schema, model, type Types } from "mongoose";

export const MEMORY_TYPES = {
  FACT: "FACT",
  PREFERENCE: "PREFERENCE",
  GOAL: "GOAL",
  INSTRUCTION: "INSTRUCTION",
} as const;

export type MemoryType = (typeof MEMORY_TYPES)[keyof typeof MEMORY_TYPES];

export const MEMORY_STATUSES = {
  ACTIVE: "ACTIVE",
  DELETED: "DELETED",
} as const;

export type MemoryStatus =
  (typeof MEMORY_STATUSES)[keyof typeof MEMORY_STATUSES];

export interface IMemory {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: MemoryType;
  content: string;
  embedding?: number[] | undefined;
  status: MemoryStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const memorySchema = new Schema<IMemory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: Object.values(MEMORY_TYPES),
      required: true,
    },

    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },

    embedding: {
      type: [Number],
      required: false,
      select: false,
    },

    status: {
      type: String,
      enum: Object.values(MEMORY_STATUSES),
      default: MEMORY_STATUSES.ACTIVE,
      required: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index strictly justified by user-scoped active queries ordered by recency
memorySchema.index({
  userId: 1,
  status: 1,
  createdAt: -1,
});

export const Memory = model<IMemory>("Memory", memorySchema);
