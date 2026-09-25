import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as attachmentService from "./attachment.service.js";

/**
 * Handles authenticated image attachment upload:
 * POST /api/v1/attachments/image
 */
export const uploadImageAttachment = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const file = req.file;
  if (!file) {
    throw new AppError("Image file is required", 400, "MISSING_FILE");
  }

  const conversationId =
    typeof req.body?.conversationId === "string" &&
    req.body.conversationId.trim().length > 0
      ? req.body.conversationId.trim()
      : typeof req.query?.conversationId === "string" &&
        req.query.conversationId.trim().length > 0
      ? req.query.conversationId.trim()
      : undefined;

  if (!conversationId) {
    throw new AppError(
      "conversationId is required",
      400,
      "MISSING_CONVERSATION_ID",
    );
  }

  const result = await attachmentService.uploadImageAttachment({
    userId: authUser.userId,
    conversationId,
    file: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  });

  res.status(201).json({
    success: true,
    data: result,
  });
};

/**
 * Handles authenticated document attachment upload:
 * POST /api/v1/attachments/document
 */
export const uploadDocumentAttachment = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const file = req.file;
  if (!file) {
    throw new AppError("Document file is required", 400, "MISSING_FILE");
  }

  const conversationId =
    typeof req.body?.conversationId === "string" &&
    req.body.conversationId.trim().length > 0
      ? req.body.conversationId.trim()
      : typeof req.query?.conversationId === "string" &&
        req.query.conversationId.trim().length > 0
      ? req.query.conversationId.trim()
      : undefined;

  if (!conversationId) {
    throw new AppError(
      "conversationId is required",
      400,
      "MISSING_CONVERSATION_ID",
    );
  }

  const result = await attachmentService.uploadDocumentAttachment({
    userId: authUser.userId,
    conversationId,
    file: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  });

  res.status(201).json({
    success: true,
    data: result,
  });
};

export const deleteAttachment = async (
  req: Request<{ attachmentId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { attachmentId } = req.params;
  const result = await attachmentService.deleteAttachment(
    attachmentId,
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: result,
  });
};
