import { Router } from "express";
import * as voiceController from "./voice.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { uploadSingleAudio } from "../../middleware/upload.js";
import { voiceRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.use(authenticate);

router.post(
  "/transcribe",
  voiceRateLimiter,
  uploadSingleAudio,
  voiceController.handleTranscribeAudio,
);

export default router;
