import type { Request, Response, NextFunction } from "express";
import { AppError } from "../../errors/app.error.js";
import { voiceService } from "./voice.service.js";

export const handleTranscribeAudio = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      throw new AppError("Audio file is required in field 'file' or 'audio'", 400, "MISSING_FILE");
    }

    if (!file.buffer || file.buffer.length < 100) {
      throw new AppError("Audio recording is empty or too short. Please speak into the microphone.", 400, "INVALID_AUDIO");
    }

    const language = typeof req.body?.language === "string" ? req.body.language : undefined;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : undefined;

    const result = await voiceService.transcribeAudio(
      file.buffer,
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
  }
};
