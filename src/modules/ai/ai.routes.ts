import { Router } from "express";
import * as aiController from "./ai.controller.js";
import { chatRequestSchema } from "./ai.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";
import { aiRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.use(authenticate);

router.post(
  "/chat",
  aiRateLimiter,
  validate(chatRequestSchema),
  aiController.handleChat,
);

export default router;
