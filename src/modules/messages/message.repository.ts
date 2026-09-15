import type { Types } from "mongoose";
import {
  Message,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "./message.model.js";

export type MessageRole =
  (typeof MESSAGE_ROLES)[keyof typeof MESSAGE_ROLES];

export type MessageStatus =
  (typeof MESSAGE_STATUSES)[keyof typeof MESSAGE_STATUSES];

export type MessageUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type CreateMessageData = {
  conversationId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  model?: string | null;
  provider?: string | null;
  usage?: MessageUsage | null;
};

export const createMessage = async (data: CreateMessageData) => {
  return Message.create(data);
};

export const findMessageById = async (
  messageId: string | Types.ObjectId,
) => {
  return Message.findById(messageId);
};

export const findMessagesByConversationId = async (
  conversationId: string | Types.ObjectId,
) => {
  return Message.find({ conversationId }).sort({ createdAt: 1 });
};

export const countMessagesByConversationId = async (
  conversationId: string | Types.ObjectId,
) => {
  return Message.countDocuments({ conversationId });
};
