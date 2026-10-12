import { Router } from "express";
import * as agentController from "./agent.controller.js";
import { executeAgentSchema } from "./agent.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";
import { aiRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.use(authenticate);

router.post(
  "/execute",
  aiRateLimiter,
  validate(executeAgentSchema),
  agentController.handleExecuteAgent,
);

router.post(
  "/run",
  aiRateLimiter,
  validate(executeAgentSchema),
  agentController.handleExecuteAgent,
);

router.post(
  "/stream",
  aiRateLimiter,
  validate(executeAgentSchema),
  agentController.handleExecuteAgentStream,
);

router.post(
  "/run/stream",
  aiRateLimiter,
  validate(executeAgentSchema),
  agentController.handleExecuteAgentStream,
);

export default router;
