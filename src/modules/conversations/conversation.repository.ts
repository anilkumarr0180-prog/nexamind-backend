import type { Types } from "mongoose";
import {
  Conversation,
  CONVERSATION_STATUSES,
} from "./conversation.model.js";

export type ConversationStatus =
  (typeof CONVERSATION_STATUSES)[keyof typeof CONVERSATION_STATUSES];

export type CreateConversationData = {
  userId: string | Types.ObjectId;
  title: string;
  status?: ConversationStatus;
  lastMessageAt?: Date | null;
  messageCount?: number;
  deletedAt?: Date | null;
};

export type UpdateConversationData = {
  title?: string;
  status?: ConversationStatus;
  lastMessageAt?: Date | null;
  messageCount?: number;
  deletedAt?: Date | null;
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
