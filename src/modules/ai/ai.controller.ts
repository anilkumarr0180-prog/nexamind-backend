import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as orchestratorService from "./orchestrator.service.js";
import type { ChatRequestBody } from "./ai.validation.js";

export const handleChat = async (
  req: Request<Record<string, never>, unknown, ChatRequestBody>,
  res: Response,
): Promise<void> => {
  if (req.body.stream || req.headers.accept?.includes("text/event-stream")) {
    return handleChatStream(req, res);
  }

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

export const handleChatStream = async (
  req: Request<Record<string, never>, unknown, ChatRequestBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  const userId = authUser?.sub ?? authUser?.userId;

  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const abortController = new AbortController();

  req.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  let headersSent = false;

  try {
    const result = await orchestratorService.processChatStream(
      userId,
      req.body,
      {
        onStart: (startData) => {
          if (!headersSent && !res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders?.();
            headersSent = true;
          }
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "start", ...startData })}\n\n`);
          }
        },
        onChunk: (chunk) => {
          if (!chunk) return;
          if (!headersSent && !res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders?.();
            headersSent = true;
          }
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
          }
        },
      },
      abortController.signal,
    );

    if (!res.writableEnded) {
      if (!headersSent && !res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        headersSent = true;
      }
      if (result) {
        res.write(`data: ${JSON.stringify({ type: "done", ...result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "aborted" })}\n\n`);
      }
      res.end();
    }
  } catch (error: unknown) {
    if (res.headersSent || headersSent) {
      if (!res.writableEnded) {
        const statusCode = error instanceof AppError ? error.statusCode : 502;
        const code = error instanceof AppError ? error.code : "AI_PROVIDER_ERROR";
        const message = error instanceof AppError ? error.message : "Failed to generate AI response";

        res.write(
          `data: ${JSON.stringify({
            type: "error",
            error: { message, code, statusCode },
          })}\n\n`,
        );
        res.end();
      }
    } else {
      throw error;
    }
  }
};
