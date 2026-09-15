import { Router } from "express";
import * as authController from "./auth.controller.js";
import { loginSchema, registerSchema } from "./auth.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.post("/register", validate(registerSchema), authController.register);
router.post("/login", validate(loginSchema), authController.login);
router.get("/me", authenticate, authController.getMe);

export default router;
