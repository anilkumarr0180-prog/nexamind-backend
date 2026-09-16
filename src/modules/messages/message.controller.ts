import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as messageService from "./message.service.js";
import type {
  CreateUserMessageBody,
  CreateUserMessageParams,
  GetConversationMessagesParams,
  GetMessageByIdParams,
} from "./message.validation.js";

export const createUserMessage = async (
  req: Request<CreateUserMessageParams, unknown, CreateUserMessageBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;

  const message = await messageService.createUserMessage(
    authUser.userId,
    conversationId,
    req.body,
  );

  res.status(201).json({
    success: true,
    data: message,
  });
};

export const getConversationMessages = async (
  req: Request<GetConversationMessagesParams>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { conversationId } = req.params;
  const page =
    typeof req.query.page === "string"
      ? parseInt(req.query.page, 10)
      : undefined;
  const limit =
    typeof req.query.limit === "string"
      ? parseInt(req.query.limit, 10)
      : undefined;

  const result = await messageService.getConversationMessages(
    conversationId,
    authUser.userId,
    { page, limit },
  );

  res.status(200).json({
    success: true,
    data: result.items,
    pagination: result.pagination,
  });
};

export const getMessageById = async (
  req: Request<GetMessageByIdParams>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { messageId } = req.params;

  const message = await messageService.getMessageById(
    messageId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: message,
  });
};
