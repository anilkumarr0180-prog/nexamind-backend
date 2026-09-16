import { Router } from "express";
import * as tokenController from "./token.controller.js";
import { getBalanceSchema } from "./token.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.get(
  "/balance",
  validate(getBalanceSchema),
  tokenController.getBalance,
);

export default router;
