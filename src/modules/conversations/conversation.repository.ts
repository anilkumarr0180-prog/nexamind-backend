import type { Types } from "mongoose";
import {
  Conversation,
  CONVERSATION_STATUSES,
} from "./conversation.model.js";
import type { PaginationOptions } from "../../utils/pagination.js";

export type ConversationStatus =
  (typeof CONVERSATION_STATUSES)[keyof typeof CONVERSATION_STATUSES];

export type CreateConversationData = {
  userId: string | Types.ObjectId;
  title: string;
  status?: ConversationStatus;
  lastMessageAt?: Date | null;
  messageCount?: number;
  deletedAt?: Date | null;
  summary?: string | null;
  summaryUpdatedAt?: Date | null;
  lastSummarizedMessageCount?: number;
};

export type UpdateConversationData = {
  title?: string;
  status?: ConversationStatus;
  lastMessageAt?: Date | null;
  messageCount?: number;
  deletedAt?: Date | null;
  summary?: string | null;
  summaryUpdatedAt?: Date | null;
  lastSummarizedMessageCount?: number;
};

export const createConversation = async (data: CreateConversationData) => {
  return Conversation.create(data);
};

export const findConversationById = async (
  conversationId: string | Types.ObjectId,
) => {
  return Conversation.findOne({
    _id: conversationId,
    deletedAt: null,
  });
};

export const findConversationByIdAndUserId = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
) => {
  return Conversation.findOne({
    _id: conversationId,
    userId,
    deletedAt: null,
  });
};

export const findConversationByIdAndUserIdWithDeleted = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
) => {
  return Conversation.findOne({
    _id: conversationId,
    userId,
  });
};

export const findConversationsByUserId = async (
  userId: string | Types.ObjectId,
) => {
  return Conversation.find({ userId, deletedAt: null }).sort({ updatedAt: -1 });
};

export const findPaginatedConversationsByUserId = async (
  userId: string | Types.ObjectId,
  options?: PaginationOptions,
) => {
  const page = options?.page ?? 1;
  const limit = options?.limit ?? 20;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Conversation.find({ userId, deletedAt: null })
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Conversation.countDocuments({ userId, deletedAt: null }),
  ]);

  return {
    items,
    total,
  };
};

export const updateConversation = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
  data: UpdateConversationData,
) => {
  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      userId,
      deletedAt: null,
    },
    data,
    { returnDocument: "after" },
  );
};

export const softDeleteConversation = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
) => {
  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      userId,
      deletedAt: null,
    },
    {
      deletedAt: new Date(),
    },
    { returnDocument: "after" },
  );
};


export const updateConversationSummary = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
  summary: string,
  messageCount: number,
) => {
  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      userId,
      deletedAt: null,
    },
    {
      summary,
      summaryUpdatedAt: new Date(),
      lastSummarizedMessageCount: messageCount,
    },
    { returnDocument: "after" },
  );
};

export const findRecentSummarizedConversationsByUserId = async (
  userId: string | Types.ObjectId,
  excludeConversationId?: string | Types.ObjectId,
  limit: number = 50,
) => {
  if (!userId) {
    return [];
  }

  const query: Record<string, unknown> = {
    userId,
    deletedAt: null,
    summary: { $exists: true, $ne: null, $nin: ["", null] },
  };

  if (excludeConversationId) {
    query._id = { $ne: excludeConversationId };
  }

  return Conversation.find(query)
    .sort({ summaryUpdatedAt: -1, updatedAt: -1 })
    .limit(limit)
    .select("_id userId title summary summaryUpdatedAt updatedAt deletedAt")
    .lean();
};
