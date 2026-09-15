import { Router } from "express";
import * as messageController from "./message.controller.js";
import {
  createUserMessageSchema,
  getConversationMessagesSchema,
  getMessageByIdSchema,
} from "./message.validation.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.post(
  "/conversations/:conversationId/messages",
  validate(createUserMessageSchema),
  messageController.createUserMessage,
);

router.get(
  "/conversations/:conversationId/messages",
  validate(getConversationMessagesSchema),
  messageController.getConversationMessages,
);

router.get(
  "/messages/:messageId",
  validate(getMessageByIdSchema),
  messageController.getMessageById,
);

export default router;
