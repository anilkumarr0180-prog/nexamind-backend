import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as orchestratorService from "./orchestrator.service.js";
import type { ChatRequestBody } from "./ai.validation.js";

export const handleChat = async (
  req: Request<Record<string, never>, unknown, ChatRequestBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  const userId = authUser?.sub ?? authUser?.userId;

  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const result = await orchestratorService.processChatRequest(
    userId,
    req.body,
  );

  res.status(200).json({
    success: true,
    data: result,
  });
};
