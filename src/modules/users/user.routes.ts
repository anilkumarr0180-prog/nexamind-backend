import { Router } from "express";
import * as userController from "./user.controller.js";
import { getUserByIdSchema } from "./user.validation.js";
import { validate } from "../../middleware/validate.js";

const router = Router();

router.get(
  "/:userId",
  validate(getUserByIdSchema),
  userController.getUserById,
);

export default router;