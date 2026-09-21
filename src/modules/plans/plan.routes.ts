import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as planController from "./plan.controller.js";
import {
  getPlansSchema,
  getPlanByCodeSchema,
} from "./plan.validation.js";

const router = Router();

// GET /api/v1/plans
router.get(
  "/",
  validate(getPlansSchema),
  planController.getPlans,
);

// GET /api/v1/plans/:code
router.get(
  "/:code",
  validate(getPlanByCodeSchema),
  planController.getPlanByCode,
);

export default router;
