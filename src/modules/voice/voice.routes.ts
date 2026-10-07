import { Router } from "express";
import * as voiceController from "./voice.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { uploadSingleAudio } from "../../middleware/upload.js";

const router = Router();

router.use(authenticate);

router.post(
  "/transcribe",
  uploadSingleAudio,
  voiceController.handleTranscribeAudio,
);

export default router;
