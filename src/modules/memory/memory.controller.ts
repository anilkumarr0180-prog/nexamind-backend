import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as memoryService from "./memory.service.js";
import type {
  CreateMemoryBody,
  DeleteMemoryParams,
  GetMemoryByIdParams,
  UpdateMemoryBody,
  UpdateMemoryParams,
} from "./memory.validation.js";
import type { MemoryType } from "./memory.model.js";

const getAuthenticatedUserId = (req: Request): string => {
  const userId = req.user?.sub ?? req.user?.userId;
  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }
  return userId;
};

export const createMemory = async (
  req: Request<Record<string, never>, unknown, CreateMemoryBody>,
  res: Response,
): Promise<void> => {
  const userId = getAuthenticatedUserId(req);

  const memory = await memoryService.createMemory(userId, {
    type: req.body.type,
    content: req.body.content,
  });

  res.status(201).json({
    success: true,
    data: memory,
  });
};

export const getUserMemories = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = getAuthenticatedUserId(req);

  const type =
    typeof req.query.type === "string"
      ? (req.query.type as MemoryType)
      : undefined;

  const memories = await memoryService.getUserMemories(
    userId,
    type ? { type } : undefined,
  );

  res.status(200).json({
    success: true,
    data: memories,
  });
};

export const getMemoryById = async (
  req: Request<GetMemoryByIdParams>,
  res: Response,
): Promise<void> => {
  const userId = getAuthenticatedUserId(req);

  const { memoryId } = req.params;
  const memory = await memoryService.getMemoryById(memoryId, userId);

  res.status(200).json({
    success: true,
    data: memory,
  });
};

export const updateMemory = async (
  req: Request<UpdateMemoryParams, unknown, UpdateMemoryBody>,
  res: Response,
): Promise<void> => {
  const userId = getAuthenticatedUserId(req);

  const { memoryId } = req.params;
  const updatePayload: memoryService.UpdateMemoryInput = {};

  if (req.body.type !== undefined) {
    updatePayload.type = req.body.type;
  }
  if (req.body.content !== undefined) {
    updatePayload.content = req.body.content;
  }

  const memory = await memoryService.updateMemory(
    memoryId,
    userId,
    updatePayload,
  );

  res.status(200).json({
    success: true,
    data: memory,
  });
};

export const deleteMemory = async (
  req: Request<DeleteMemoryParams>,
  res: Response,
): Promise<void> => {
  const userId = getAuthenticatedUserId(req);

  const { memoryId } = req.params;
  const memory = await memoryService.deleteMemory(memoryId, userId);

  res.status(200).json({
    success: true,
    data: memory,
  });
};
