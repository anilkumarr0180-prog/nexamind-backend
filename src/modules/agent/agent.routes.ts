import { Router } from "express";
import * as agentController from "./agent.controller.js";
import { executeAgentSchema } from "./agent.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.post(
  "/execute",
  validate(executeAgentSchema),
  agentController.handleExecuteAgent,
);

router.post(
  "/run",
  validate(executeAgentSchema),
  agentController.handleExecuteAgent,
);

router.post(
  "/stream",
  validate(executeAgentSchema),
  agentController.handleExecuteAgentStream,
);

router.post(
  "/run/stream",
  validate(executeAgentSchema),
  agentController.handleExecuteAgentStream,
);

export default router;
