import { Schema, model } from "mongoose";

export const CONVERSATION_STATUSES = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;

const conversationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    status: {
      type: String,
      enum: Object.values(CONVERSATION_STATUSES),
      default: CONVERSATION_STATUSES.ACTIVE,
      required: true,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    messageCount: {
      type: Number,
      default: 0,
      min: 0,
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

conversationSchema.index({
  userId: 1,
  updatedAt: -1,
});

export const Conversation = model(
  "Conversation",
  conversationSchema,
);