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
  let isStreamCompleted = false;

  const handleDisconnect = () => {
    // Only abort if the connection closed prematurely before the stream completed
    if (!isStreamCompleted && !res.writableEnded && !res.writableFinished) {
      abortController.abort();
    }
  };

  // Listen to both request and response close to detect client disconnection at any stage
  req.on("close", handleDisconnect);
  res.on("close", handleDisconnect);

  let headersSent = false;

  const ensureHeaders = () => {
    if (!headersSent && !res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      headersSent = true;
    }
  };

  try {
    const result = await orchestratorService.processChatStream(
      userId,
      req.body,
      {
        onStart: (startData) => {
          ensureHeaders();
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "start", ...startData })}\n\n`);
          }
        },
        onStatus: (status, message) => {
          ensureHeaders();
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "status", status, message })}\n\n`);
          }
        },
        onToolStatus: (toolStatus) => {
          ensureHeaders();
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "tool_status", ...toolStatus })}\n\n`);
          }
        },
        onChunk: (chunk) => {
          if (!chunk) return;
          ensureHeaders();
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
          }
        },
      },
      abortController.signal,
    );

    isStreamCompleted = true;

    if (!res.writableEnded) {
      ensureHeaders();
      if (result) {
        res.write(`data: ${JSON.stringify({ type: "done", ...result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "aborted" })}\n\n`);
      }
      res.end();
    }
  } catch (error: unknown) {
    isStreamCompleted = true;
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
  } finally {
    isStreamCompleted = true;
    req.removeListener("close", handleDisconnect);
    res.removeListener("close", handleDisconnect);
  }
};
