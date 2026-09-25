import { Schema, model } from "mongoose";

export const MESSAGE_ROLES = {
  USER: "USER",
  ASSISTANT: "ASSISTANT",
  SYSTEM: "SYSTEM",
  TOOL: "TOOL",
} as const;

export const MESSAGE_STATUSES = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

const messageUsageSchema = new Schema(
  {
    inputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    outputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    totalTokens: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    _id: false,
  },
);

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: Object.values(MESSAGE_ROLES),
      required: true,
    },

    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100000,
    },

    status: {
      type: String,
      enum: Object.values(MESSAGE_STATUSES),
      default: MESSAGE_STATUSES.COMPLETED,
      required: true,
    },

    model: {
      type: String,
      default: null,
      trim: true,
    },

    provider: {
      type: String,
      default: null,
      trim: true,
    },

    usage: {
      type: messageUsageSchema,
      default: null,
    },

    parentMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
      index: true,
    },

    originalMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
      index: true,
    },

    attachmentId: {
      type: Schema.Types.ObjectId,
      ref: "Attachment",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

messageSchema.index({
  conversationId: 1,
  createdAt: 1,
});

export const Message = model(
  "Message",
  messageSchema,
);