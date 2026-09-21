import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  getMySubscription,
  createCheckoutSession,
  getPortalSession,
} from "./subscription.controller.js";
import { createCheckoutSessionSchema } from "./subscription.validation.js";

const router = Router();

router.get(
  "/me",
  authenticate,
  getMySubscription,
);

router.post(
  "/checkout",
  authenticate,
  validate(createCheckoutSessionSchema),
  createCheckoutSession,
);

router.get(
  "/portal",
  authenticate,
  getPortalSession,
);

export default router;