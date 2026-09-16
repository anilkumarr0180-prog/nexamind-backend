import { AppError } from "../../errors/app.error.js";
import { CONVERSATION_STATUSES } from "./conversation.model.js";
import * as conversationRepository from "./conversation.repository.js";
import type {
  ConversationStatus,
  UpdateConversationData,
} from "./conversation.repository.js";
import {
  calculatePagination,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  toPaginatedResult,
} from "../../utils/pagination.js";
import type { PaginationOptions } from "../../utils/pagination.js";

export type CreateConversationInput = {
  title: string;
};

export type UpdateConversationInput = {
  title?: string;
  status?: ConversationStatus;
};

export const createConversation = async (
  userId: string,
  data: CreateConversationInput,
) => {
  const trimmedTitle = data.title?.trim();

  if (!trimmedTitle) {
    throw new AppError(
      "Conversation title is required",
      400,
      "INVALID_INPUT",
    );
  }

  return conversationRepository.createConversation({
    userId,
    title: trimmedTitle,
    status: CONVERSATION_STATUSES.ACTIVE,
    messageCount: 0,
    lastMessageAt: null,
  });
};

export const getConversationById = async (
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

  return conversation;
};

export const getUserConversations = async (
  userId: string,
  options?: PaginationOptions,
) => {
  const page = options?.page ?? DEFAULT_PAGE;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  const { items, total } =
    await conversationRepository.findPaginatedConversationsByUserId(userId, {
      page,
      limit,
    });

  const pagination = calculatePagination(total, page, limit);

  return toPaginatedResult(items, pagination);
};

export const updateConversation = async (
  conversationId: string,
  userId: string,
  data: UpdateConversationInput,
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

  const updateData: UpdateConversationData = {};

  if (data.title !== undefined) {
    const trimmedTitle = data.title.trim();
    if (!trimmedTitle) {
      throw new AppError(
        "Conversation title cannot be empty",
        400,
        "INVALID_INPUT",
      );
    }
    updateData.title = trimmedTitle;
  }

  if (data.status !== undefined) {
    if (
      data.status !== CONVERSATION_STATUSES.ACTIVE &&
      data.status !== CONVERSATION_STATUSES.ARCHIVED
    ) {
      throw new AppError(
        "Invalid conversation status",
        400,
        "INVALID_STATUS",
      );
    }

    if (
      conversation.status === CONVERSATION_STATUSES.ARCHIVED &&
      data.status === CONVERSATION_STATUSES.ACTIVE
    ) {
      throw new AppError(
        "Archived conversations cannot be reactivated",
        400,
        "INVALID_STATUS_TRANSITION",
      );
    }

    updateData.status = data.status;
  }

  const updatedConversation =
    await conversationRepository.updateConversation(
      conversationId,
      userId,
      updateData,
    );

  if (!updatedConversation) {
    throw new AppError(
      "Conversation not found",
      404,
      "CONVERSATION_NOT_FOUND",
    );
  }

  return updatedConversation;
};

export const archiveConversation = async (
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

  if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
    return conversation;
  }

  const updatedConversation =
    await conversationRepository.updateConversation(
      conversationId,
      userId,
      { status: CONVERSATION_STATUSES.ARCHIVED },
    );

  if (!updatedConversation) {
    throw new AppError(
      "Conversation not found",
      404,
      "CONVERSATION_NOT_FOUND",
    );
  }

  return updatedConversation;
};

export const unarchiveConversation = async (
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

  if (conversation.status === CONVERSATION_STATUSES.ACTIVE) {
    return conversation;
  }

  if (conversation.status !== CONVERSATION_STATUSES.ARCHIVED) {
    throw new AppError(
      "Only archived conversations can be unarchived",
      400,
      "INVALID_STATUS_TRANSITION",
    );
  }

  const updatedConversation =
    await conversationRepository.updateConversation(
      conversationId,
      userId,
      { status: CONVERSATION_STATUSES.ACTIVE },
    );

  if (!updatedConversation) {
    throw new AppError(
      "Conversation not found",
      404,
      "CONVERSATION_NOT_FOUND",
    );
  }

  return updatedConversation;
};

export const deleteConversation = async (
  conversationId: string,
  userId: string,
) => {
  const conversation =
    await conversationRepository.findConversationByIdAndUserId(
      conversationId,
      userId,
    );

  if (conversation) {
    const deletedConversation =
      await conversationRepository.softDeleteConversation(
        conversationId,
        userId,
      );

    if (!deletedConversation) {
      const alreadyDeleted =
        await conversationRepository.findConversationByIdAndUserIdWithDeleted(
          conversationId,
          userId,
        );
      if (alreadyDeleted) {
        return alreadyDeleted;
      }
      throw new AppError(
        "Conversation not found",
        404,
        "CONVERSATION_NOT_FOUND",
      );
    }

    return deletedConversation;
  }

  const existingDeleted =
    await conversationRepository.findConversationByIdAndUserIdWithDeleted(
      conversationId,
      userId,
    );

  if (existingDeleted && existingDeleted.deletedAt !== null) {
    return existingDeleted;
  }

  throw new AppError(
    "Conversation not found",
    404,
    "CONVERSATION_NOT_FOUND",
  );
};
