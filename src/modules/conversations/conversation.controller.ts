import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as conversationService from "./conversation.service.js";
import type {
  CreateConversationBody,
  UpdateConversationBody,
} from "./conversation.validation.js";

export const createConversation = async (
  req: Request<Record<string, never>, unknown, CreateConversationBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const conversation = await conversationService.createConversation(
    authUser.userId,
    req.body,
  );

  res.status(201).json({
    success: true,
    data: conversation,
  });
};

export const getUserConversations = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const page =
    typeof req.query.page === "string"
      ? parseInt(req.query.page, 10)
      : undefined;
  const limit =
    typeof req.query.limit === "string"
      ? parseInt(req.query.limit, 10)
      : undefined;

  const result = await conversationService.getUserConversations(
    authUser.userId,
    { page, limit },
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
};

export const getConversationById = async (
  req: Request<{ conversationId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const conversation = await conversationService.getConversationById(
    conversationId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: conversation,
  });
};

export const updateConversation = async (
  req: Request<{ conversationId: string }, unknown, UpdateConversationBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const updatePayload: conversationService.UpdateConversationInput = {};
  if (req.body.title !== undefined) {
    updatePayload.title = req.body.title;
  }
  if (req.body.status !== undefined) {
    updatePayload.status = req.body.status;
  }

  const conversation = await conversationService.updateConversation(
    conversationId,
    authUser.userId,
    updatePayload,
  );

  res.status(200).json({
    success: true,
    data: conversation,
  });
};

export const archiveConversation = async (
  req: Request<{ conversationId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const conversation = await conversationService.archiveConversation(
    conversationId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: conversation,
  });
};

export const unarchiveConversation = async (
  req: Request<{ conversationId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const conversation = await conversationService.unarchiveConversation(
    conversationId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: conversation,
  });
};

export const deleteConversation = async (
  req: Request<{ conversationId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const conversation = await conversationService.deleteConversation(
    conversationId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: conversation,
  });
};
