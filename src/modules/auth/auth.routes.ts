import { Router } from "express";
import * as authController from "./auth.controller.js";
import {
  googleAuthSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  vscodeAuthorizeSchema,
  vscodeExchangeSchema,
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

// VS Code Extension PKCE Authentication Renewal Routes (Phase 2.2)
router.post(
  "/vscode/authorize",
  authRateLimiter,
  authenticate,
  validate(vscodeAuthorizeSchema),
  authController.vscodeAuthorize,
);
router.post(
  "/vscode/exchange",
  authRateLimiter,
  validate(vscodeExchangeSchema),
  authController.vscodeExchange,
);

// Token Refresh & Logout Routes (Phase 2.2)
router.post(
  "/refresh",
  authRateLimiter,
  validate(refreshSchema),
  authController.refresh,
);
router.post(
  "/logout",
  authRateLimiter,
  validate(logoutSchema),
  authController.logout,
);

export default router;
