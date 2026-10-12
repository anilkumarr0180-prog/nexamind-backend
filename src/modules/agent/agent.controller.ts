import { Types } from "mongoose";
import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import { agentService, AgentService } from "./agent.service.js";
import { AGENT_STATUSES } from "./agent.types.js";
import * as tokenService from "../tokens/token.service.js";
import {
  acquireConversationGenerationLock,
  releaseConversationGenerationLock,
} from "../ai/orchestrator.service.js";
import type { ExecuteAgentBody } from "./agent.validation.js";

let defaultService: AgentService = agentService;

export const setAgentService = (service: AgentService): void => {
  defaultService = service;
};

export const getAgentService = (): AgentService => {
  return defaultService;
};

export const handleExecuteAgent = async (
  req: Request<Record<string, never>, unknown, ExecuteAgentBody>,
  res: Response,
): Promise<void> => {
  if (req.body.stream || req.headers.accept?.includes("text/event-stream")) {
    return handleExecuteAgentStream(req, res);
  }

  const authUser = req.user;
  const userId = authUser?.sub ?? authUser?.userId;

  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { task, conversationId, systemPrompt, maxSteps, context } = req.body;
  const convId = conversationId ? String(conversationId).trim() : undefined;

  if (convId) {
    if (!acquireConversationGenerationLock(convId)) {
      throw new AppError(
        "Another AI generation is currently active for this conversation",
        409,
        "GENERATION_IN_PROGRESS",
      );
    }
  }

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ||
      (req.headers["x-request-id"] as string | undefined) ||
      req.body.idempotencyKey ||
      new Types.ObjectId().toString();

    const creditReferenceId = `agent_${convId ? convId + "_" : ""}${idempotencyKey}`;
    const refundReferenceId = `refund_${creditReferenceId}`;

    await tokenService.deductCredits(userId, 1, creditReferenceId);
    try {
      const result = await defaultService.execute(
        {
          userId,
          task,
          conversationId,
          systemPrompt,
          maxSteps,
          context,
        },
        {
          signal: abortController.signal,
        },
      );

      if (result.status === AGENT_STATUSES.FAILED && !result.output) {
        try {
          await tokenService.refundCredits(userId, 1, refundReferenceId);
        } catch (refundErr) {
          console.error("Refund failed on agent execution failure:", refundErr);
        }
      }

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      try {
        await tokenService.refundCredits(userId, 1, refundReferenceId);
      } catch (refundErr) {
        console.error("Refund failed on agent execution error:", refundErr);
      }
      throw error;
    }
  } finally {
    if (convId) {
      releaseConversationGenerationLock(convId);
    }
  }
};

export const handleExecuteAgentStream = async (
  req: Request<Record<string, never>, unknown, ExecuteAgentBody>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  const userId = authUser?.sub ?? authUser?.userId;

  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const convId = req.body.conversationId
    ? String(req.body.conversationId).trim()
    : undefined;

  if (convId) {
    if (!acquireConversationGenerationLock(convId)) {
      throw new AppError(
        "Another AI generation is currently active for this conversation",
        409,
        "GENERATION_IN_PROGRESS",
      );
    }
  }

  const abortController = new AbortController();

  req.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    let headersSent = false;
    const sendHeaders = (): void => {
      if (!headersSent && !res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        headersSent = true;
      }
    };

    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ||
      (req.headers["x-request-id"] as string | undefined) ||
      req.body.idempotencyKey ||
      new Types.ObjectId().toString();

    const creditReferenceId = `agent_${convId ? convId + "_" : ""}${idempotencyKey}`;
    const refundReferenceId = `refund_${creditReferenceId}`;

    await tokenService.deductCredits(userId, 1, creditReferenceId);
    try {
      const result = await defaultService.executeStream(
        {
          userId,
          task: req.body.task,
          conversationId: req.body.conversationId,
          systemPrompt: req.body.systemPrompt,
          maxSteps: req.body.maxSteps,
          context: req.body.context,
        },
        {
          onStart: (startData) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "start", ...startData })}\n\n`);
            }
          },
          onStatus: (status, message) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "status", status, message })}\n\n`);
            }
          },
          onPlan: (plan) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "plan", plan })}\n\n`);
            }
          },
          onToolStatus: (toolStatus) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "tool_status", ...toolStatus })}\n\n`);
            }
          },
          onTrace: (trace) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "trace", trace })}\n\n`);
            }
          },
          onSources: (sources) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "sources", sources })}\n\n`);
            }
          },
          onChunk: (chunk) => {
            sendHeaders();
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
            }
          },
        },
        abortController.signal,
      );

      sendHeaders();
      if (!res.writableEnded && !res.destroyed) {
        if (abortController.signal.aborted || result.status === AGENT_STATUSES.CANCELLED) {
          if (!result.output) {
            try {
              await tokenService.refundCredits(userId, 1, refundReferenceId);
            } catch (refundErr) {
              console.error("Refund failed on agent stream abort:", refundErr);
            }
          }
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify({ type: "aborted", data: result })}\n\n`);
          }
        } else if (result.status === AGENT_STATUSES.FAILED) {
          if (!result.output) {
            try {
              await tokenService.refundCredits(userId, 1, refundReferenceId);
            } catch (refundErr) {
              console.error("Refund failed on agent stream failure:", refundErr);
            }
          }
          if (!res.writableEnded && !res.destroyed) {
            res.write(
              `data: ${JSON.stringify({
                type: "error",
                error: {
                  message: result.error || "Agent execution failed",
                  code: "AGENT_EXECUTION_ERROR",
                  statusCode: 502,
                },
                data: result,
              })}\n\n`,
            );
          }
        } else {
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify({ type: "done", data: result })}\n\n`);
          }
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
    } catch (error: unknown) {
      try {
        await tokenService.refundCredits(userId, 1, refundReferenceId);
      } catch (refundErr) {
        console.error("Refund failed on agent stream error:", refundErr);
      }
      if (res.headersSent || headersSent) {
        if (!res.writableEnded && !res.destroyed) {
          const statusCode = error instanceof AppError ? error.statusCode : 502;
          const code = error instanceof AppError ? error.code : "AGENT_EXECUTION_ERROR";
          const message =
            error instanceof AppError ? error.message : "Failed to execute agent";

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
  } finally {
    if (convId) {
      releaseConversationGenerationLock(convId);
    }
  }
};
