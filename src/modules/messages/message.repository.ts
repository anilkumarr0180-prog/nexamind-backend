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
  parentMessageId?: string | Types.ObjectId | null;
  originalMessageId?: string | Types.ObjectId | null;
  attachmentId?: string | Types.ObjectId | null;
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

export const findActiveBranchMessages = async (
  conversationId: string | Types.ObjectId,
  leafMessageId?: string | Types.ObjectId | null,
  limit?: number,
) => {
  const messages = await Message.find({
    conversationId,
    status: MESSAGE_STATUSES.COMPLETED,
  })
    .sort({ createdAt: 1 })
    .lean();

  if (messages.length === 0) {
    return [];
  }

  const hasAnyParent = messages.some((m) => m.parentMessageId);
  if (!hasAnyParent && !leafMessageId) {
    return typeof limit === "number" && limit > 0 ? messages.slice(-limit) : messages;
  }

  const msgMap = new Map(messages.map((m) => [m._id.toString(), m]));

  let targetId = leafMessageId
    ? leafMessageId.toString()
    : messages[messages.length - 1]!._id.toString();
  let current = msgMap.get(targetId);

  if (!current) {
    current = messages[messages.length - 1];
  }

  const branchMessages: typeof messages = [];
  const visited = new Set<string>();

  while (current && !visited.has(current._id.toString())) {
    visited.add(current._id.toString());
    branchMessages.unshift(current);
    if (current.parentMessageId) {
      current = msgMap.get(current.parentMessageId.toString());
    } else {
      const legacyBefore = messages.filter(
        (m) =>
          !m.parentMessageId &&
          m.createdAt < current!.createdAt &&
          !visited.has(m._id.toString()),
      );
      if (legacyBefore.length > 0) {
        branchMessages.unshift(...legacyBefore);
      }
      break;
    }
  }

  return typeof limit === "number" && limit > 0
    ? branchMessages.slice(-limit)
    : branchMessages;
};

export const findRecentMessagesForContext = async (
  conversationId: string | Types.ObjectId,
  limit: number,
  leafMessageId?: string | Types.ObjectId | null,
) => {
  return findActiveBranchMessages(conversationId, leafMessageId, limit);
};

