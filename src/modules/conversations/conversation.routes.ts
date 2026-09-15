import { Router } from "express";
import * as conversationController from "./conversation.controller.js";
import {
  archiveConversationSchema,
  createConversationSchema,
  deleteConversationSchema,
  getConversationByIdSchema,
  unarchiveConversationSchema,
  updateConversationSchema,
} from "./conversation.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.post(
  "/",
  validate(createConversationSchema),
  conversationController.createConversation,
);

router.get(
  "/",
  conversationController.getUserConversations,
);

router.get(
  "/:conversationId",
  validate(getConversationByIdSchema),
  conversationController.getConversationById,
);

router.patch(
  "/:conversationId",
  validate(updateConversationSchema),
  conversationController.updateConversation,
);

router.post(
  "/:conversationId/archive",
  validate(archiveConversationSchema),
  conversationController.archiveConversation,
);

router.post(
  "/:conversationId/unarchive",
  validate(unarchiveConversationSchema),
  conversationController.unarchiveConversation,
);

router.delete(
  "/:conversationId",
  validate(deleteConversationSchema),
  conversationController.deleteConversation,
);

export default router;
