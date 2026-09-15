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

  const messages = await messageService.getConversationMessages(
    conversationId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: messages,
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
