import type { Request, Response, NextFunction } from "express";
import fs from "node:fs";
import { AppError } from "../../errors/app.error.js";
import { voiceService } from "./voice.service.js";
import { MAX_AUDIO_FILE_SIZE } from "../../middleware/upload.js";

export const handleTranscribeAudio = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const file = req.file;
  if (!file) {
    return next(
      new AppError("Audio file is required in field 'file' or 'audio'", 400, "MISSING_FILE")
    );
  }

  const tempFilePath = file.path;
  let isCleanedUp = false;

  const cleanupTempFile = async (): Promise<void> => {
    if (tempFilePath && !isCleanedUp) {
      isCleanedUp = true;
      try {
        await fs.promises.unlink(tempFilePath);
      } catch {
        // Defensive: ignore if already unlinked
      }
    }
  };

  // Ensure temporary file is removed if client aborts/closes mid-request
  req.on("close", () => {
    if (!res.writableEnded) {
      cleanupTempFile().catch(() => {});
    }
  });

  try {
    let fileSize = 0;
    if (typeof file.size === "number" && file.size > 0) {
      fileSize = file.size;
    } else if (tempFilePath) {
      try {
        const stat = await fs.promises.stat(tempFilePath);
        fileSize = stat.size;
      } catch {
        throw new AppError("Audio recording is empty or too short. Please speak into the microphone.", 400, "INVALID_AUDIO");
      }
    } else if (file.buffer) {
      fileSize = file.buffer.length;
    }

    if (fileSize > MAX_AUDIO_FILE_SIZE) {
      throw new AppError(
        `File size exceeds maximum allowed limit of ${MAX_AUDIO_FILE_SIZE / (1024 * 1024)}MB`,
        400,
        "FILE_TOO_LARGE",
      );
    }

    if (fileSize < 100) {
      throw new AppError(
        "Audio recording is empty or too short. Please speak into the microphone.",
        400,
        "INVALID_AUDIO",
      );
    }

    const language = typeof req.body?.language === "string" ? req.body.language : undefined;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : undefined;

    const audioSource = tempFilePath || file.buffer;
    if (!audioSource) {
      throw new AppError("Audio file is required in field 'file' or 'audio'", 400, "MISSING_FILE");
    }

    const result = await voiceService.transcribeAudio(
      audioSource,
      file.originalname || "recording.webm",
      file.mimetype || "audio/webm",
      { language, prompt, signal: req.signal },
    );

    res.status(200).json({
      success: true,
      data: {
        text: result.text,
        language: result.language,
        duration: result.duration,
      },
    });
  } catch (error) {
    next(error);
  } finally {
    await cleanupTempFile();
  }
};
