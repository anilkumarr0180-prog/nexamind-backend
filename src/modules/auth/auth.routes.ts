import { Router } from "express";
import * as authController from "./auth.controller.js";
import {
  googleAuthSchema,
  loginSchema,
  registerSchema,
} from "./auth.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";
import { authRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.post(
  "/register",
  authRateLimiter,
  validate(registerSchema),
  authController.register,
);
router.post(
  "/login",
  authRateLimiter,
  validate(loginSchema),
  authController.login,
);
router.post(
  "/google",
  authRateLimiter,
  validate(googleAuthSchema),
  authController.googleAuth,
);
router.post(
  "/google/link",
  authRateLimiter,
  authenticate,
  validate(googleAuthSchema),
  authController.linkGoogle,
);
router.post(
  "/link-google",
  authRateLimiter,
  authenticate,
  validate(googleAuthSchema),
  authController.linkGoogle,
);
router.get("/me", authenticate, authController.getMe);

export default router;
