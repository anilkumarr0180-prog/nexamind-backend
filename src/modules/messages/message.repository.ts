import type { Types } from "mongoose";
import {
  Message,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "./message.model.js";
import type { PaginationOptions } from "../../utils/pagination.js";

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

export const findPaginatedMessagesByConversationId = async (
  conversationId: string | Types.ObjectId,
  options?: PaginationOptions,
) => {
  const page = options?.page ?? 1;
  const limit = options?.limit ?? 20;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Message.find({ conversationId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Message.countDocuments({ conversationId }),
  ]);

  return {
    items: items.reverse(),
    total,
  };
};

export const countMessagesByConversationId = async (
  conversationId: string | Types.ObjectId,
) => {
  return Message.countDocuments({ conversationId });
};

export const updateMessageStatus = async (
  messageId: string | Types.ObjectId,
  status: MessageStatus,
) => {
  return Message.findByIdAndUpdate(
    messageId,
    { status },
    { returnDocument: "after" },
  );
};

export const findRecentMessagesForContext = async (
  conversationId: string | Types.ObjectId,
  limit: number,
) => {
  const docs = await Message.find({
    conversationId,
    status: MESSAGE_STATUSES.COMPLETED,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit);

  return docs.reverse();
};

