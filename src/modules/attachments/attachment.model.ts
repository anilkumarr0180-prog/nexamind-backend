import { Schema, model } from "mongoose";
import {
  type IAttachment,
  ATTACHMENT_STATUSES,
  ATTACHMENT_TYPES,
} from "./attachment.types.js";

const attachmentSchema = new Schema<IAttachment>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: Object.values(ATTACHMENT_TYPES),
      default: ATTACHMENT_TYPES.IMAGE,
      required: true,
      index: true,
    },

    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },

    mimeType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    size: {
      type: Number,
      required: true,
      min: 1,
    },

    cloudinaryPublicId: {
      type: String,
      required: true,
      trim: true,
    },

    secureUrl: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(ATTACHMENT_STATUSES),
      default: ATTACHMENT_STATUSES.READY,
      required: true,
      index: true,
    },

    width: {
      type: Number,
      default: null,
    },

    height: {
      type: Number,
      default: null,
    },

    format: {
      type: String,
      default: null,
      trim: true,
    },

    extractedText: {
      type: String,
      default: null,
    },

    extractedTextLength: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

attachmentSchema.index({ conversationId: 1, createdAt: -1 });
attachmentSchema.index({ userId: 1, createdAt: -1 });
attachmentSchema.index({ cloudinaryPublicId: 1 });

export const Attachment = model<IAttachment>("Attachment", attachmentSchema);
