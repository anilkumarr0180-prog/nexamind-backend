import { AppError } from "../../errors/app.error.js";
import {
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
} from "./message.model.js";
import * as messageRepository from "./message.repository.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import * as conversationRepository from "../conversations/conversation.repository.js";

export type CreateUserMessageInput = {
  content: string;
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

  return messageRepository.createMessage({
    conversationId,
    userId,
    role: MESSAGE_ROLES.USER,
    content: trimmedContent,
    status: MESSAGE_STATUSES.COMPLETED,
    model: null,
    provider: null,
    usage: null,
  });
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

  return message;
};

export const getConversationMessages = async (
  conversationId: string,
  userId: string,
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

  return messageRepository.findMessagesByConversationId(conversationId);
};
