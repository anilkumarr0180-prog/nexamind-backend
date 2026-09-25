import { AppError } from "../../errors/app.error.js";
import {
  Message,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "./message.model.js";
import * as messageRepository from "./message.repository.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import * as conversationRepository from "../conversations/conversation.repository.js";
import {
  calculatePagination,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  toPaginatedResult,
} from "../../utils/pagination.js";
import { verifyAttachmentForMessage, cleanupAttachmentIfOrphaned } from "../attachments/attachment.service.js";
import { Attachment } from "../attachments/attachment.model.js";
import type { PaginationOptions } from "../../utils/pagination.js";


export interface SafeAttachment {
  attachmentId: string;
  type?: string;
  originalName: string;
  mimeType: string;
  size: number;
  secureUrl: string;
  status: string;
  width?: number | null | undefined;
  height?: number | null | undefined;
  format?: string | null | undefined;
  extractedTextLength?: number | null | undefined;
}

export function toSafeAttachment(att: any): SafeAttachment {
  return {
    attachmentId: att._id.toString(),
    type: att.type ?? "IMAGE",
    originalName: att.originalName,
    mimeType: att.mimeType,
    size: att.size,
    secureUrl: att.secureUrl,
    status: att.status,
    width: att.width ?? null,
    height: att.height ?? null,
    format: att.format ?? null,
    extractedTextLength: att.extractedTextLength ?? null,
  };
}

export type CreateUserMessageInput = {
  content: string;
  attachmentId?: string | null | undefined;
};

export const createUserMessage = async (
  userId: string,
  conversationId: string,
  data: CreateUserMessageInput,
) => {
  const conversation =
    await conversationRepository.findConversationByIdAndUserId(
      conversationId,
      userId,
    );

  if (!conversation) {
    throw new AppError(
      "Conversation not found",
      404,
      "CONVERSATION_NOT_FOUND",
    );
  }

  if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
    throw new AppError(
      "Archived conversations cannot accept new messages",
      400,
      "CONVERSATION_ARCHIVED",
    );
  }

  const trimmedContent = data.content?.trim();

  if (!trimmedContent) {
    throw new AppError(
      "Message content is required",
      400,
      "INVALID_INPUT",
    );
  }

  let safeAttachment: SafeAttachment | null = null;
  if (data.attachmentId) {
    const verified = await verifyAttachmentForMessage(data.attachmentId, userId, conversationId);
    safeAttachment = toSafeAttachment(verified);
  }

  const created = await messageRepository.createMessage({
    conversationId,
    userId,
    role: MESSAGE_ROLES.USER,
    content: trimmedContent,
    status: MESSAGE_STATUSES.COMPLETED,
    model: null,
    provider: null,
    usage: null,
    attachmentId: data.attachmentId ?? null,
  });

  const plain = typeof (created as any).toObject === "function" ? (created as any).toObject() : created;
  return {
    ...plain,
    attachmentId: plain.attachmentId?.toString() ?? null,
    attachment: safeAttachment,
  };
};

export const getMessageById = async (
  messageId: string,
  userId: string,
) => {
  const message = await messageRepository.findMessageById(messageId);

  if (!message) {
    throw new AppError(
      "Message not found",
      404,
      "MESSAGE_NOT_FOUND",
    );
  }

  const conversation =
    await conversationRepository.findConversationByIdAndUserId(
      message.conversationId.toString(),
      userId,
    );

  if (!conversation) {
    throw new AppError(
      "Message not found",
      404,
      "MESSAGE_NOT_FOUND",
    );
  }

  let safeAttachment: SafeAttachment | null = null;
  if (message.attachmentId) {
    try {
      const att = await Attachment.findOne({
        _id: message.attachmentId,
        userId,
        conversationId: message.conversationId,
      }).lean();
      if (att) {
        safeAttachment = toSafeAttachment(att);
      }
    } catch {}
  }

  const plain = typeof (message as any).toObject === "function" ? (message as any).toObject() : message;
  return {
    ...plain,
    attachmentId: plain.attachmentId?.toString() ?? null,
    attachment: safeAttachment,
  };
};

export const getConversationMessages = async (
  conversationId: string,
  userId: string,
  options?: PaginationOptions,
) => {
  const conversation =
    await conversationRepository.findConversationByIdAndUserId(
      conversationId,
      userId,
    );

  if (!conversation) {
    throw new AppError(
      "Conversation not found",
      404,
      "CONVERSATION_NOT_FOUND",
    );
  }

  const page = options?.page ?? DEFAULT_PAGE;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  const { items, total } =
    await messageRepository.findPaginatedMessagesByConversationId(
      conversationId,
      { page, limit },
    );

  const attachmentIds = [
    ...new Set(
      items
        .map((m) => (m.attachmentId ? m.attachmentId.toString() : null))
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  let attachmentMap = new Map<string, SafeAttachment>();
  if (attachmentIds.length > 0) {
    try {
      const attachments = await Attachment.find({
        _id: { $in: attachmentIds },
        userId,
        conversationId,
      }).lean();

      attachmentMap = new Map(
        attachments.map((a) => [a._id.toString(), toSafeAttachment(a)]),
      );
    } catch (attErr) {
      console.warn("Non-fatal error retrieving attachments for conversation messages:", attErr);
    }
  }

  const enrichedItems = items.map((msg) => {
    const plain = typeof (msg as any).toObject === "function" ? (msg as any).toObject() : msg;
    const attIdStr = plain.attachmentId?.toString() ?? null;
    const safeAttachment = attIdStr ? attachmentMap.get(attIdStr) ?? null : null;
    return {
      ...plain,
      attachmentId: attIdStr,
      attachment: safeAttachment,
    };
  });

  const pagination = calculatePagination(total, page, limit);

  return toPaginatedResult(enrichedItems, pagination);
};


export const deleteMessage = async (
  messageId: string,
  userId: string,
) => {
  const message = await messageRepository.findMessageById(messageId);
  if (!message) {
    throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
  }

  const conversation = await conversationRepository.findConversationByIdAndUserId(
    message.conversationId.toString(),
    userId,
  );
  if (!conversation) {
    throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
  }

  if (message.userId.toString() !== userId.trim()) {
    throw new AppError("You can only delete your own messages", 403, "FORBIDDEN");
  }

  const attachmentId = message.attachmentId;

  // Delete message
  await Message.findByIdAndDelete(message._id);

  // If message had an attachment, cleanup if it is not referenced by any other version/message
  if (attachmentId) {
    try {
      await cleanupAttachmentIfOrphaned(attachmentId.toString(), userId);
    } catch (cleanErr) {
      console.warn("[MessageService] Non-fatal attachment cleanup error:", cleanErr);
    }
  }

  return { success: true, messageId: message._id.toString() };
};
