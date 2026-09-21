import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { getMySubscription } from "./subscription.controller.js";

const router = Router();

router.get(
  "/me",
  authenticate,
  getMySubscription,
);

export default router;