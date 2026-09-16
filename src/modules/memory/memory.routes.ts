import { Router } from "express";
import * as memoryController from "./memory.controller.js";
import {
  createMemorySchema,
  deleteMemorySchema,
  getMemoriesSchema,
  getMemoryByIdSchema,
  updateMemorySchema,
} from "./memory.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.post(
  "/",
  validate(createMemorySchema),
  memoryController.createMemory,
);

router.get(
  "/",
  validate(getMemoriesSchema),
  memoryController.getUserMemories,
);

router.get(
  "/:memoryId",
  validate(getMemoryByIdSchema),
  memoryController.getMemoryById,
);

router.patch(
  "/:memoryId",
  validate(updateMemorySchema),
  memoryController.updateMemory,
);

router.delete(
  "/:memoryId",
  validate(deleteMemorySchema),
  memoryController.deleteMemory,
);

export default router;
