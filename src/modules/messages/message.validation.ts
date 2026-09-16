import { z } from "zod";
import { MAX_LIMIT } from "../../utils/pagination.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const createUserMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z
    .object({
      content: z
        .string()
        .trim()
        .min(1, "Message content cannot be empty")
        .max(100000, "Message content cannot exceed 100000 characters"),
    })
    .strict(),
  query: z.object({}).optional(),
});

export const createMessageSchema = createUserMessageSchema;

export const getConversationMessagesSchema = z.object({
  body: z.object({}).optional(),
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  query: z
    .object({
      page: z
        .string()
        .regex(/^[1-9]\d*$/, "Page must be a positive integer starting from 1")
        .optional(),
      limit: z
        .string()
        .regex(/^[1-9]\d*$/, "Limit must be a positive integer")
        .refine((val) => Number(val) <= MAX_LIMIT, `Limit cannot exceed ${MAX_LIMIT}`)
        .optional(),
    })
    .strict()
    .optional(),
});

export const getMessageByIdSchema = z.object({
  body: z.object({}).optional(),
  params: z.object({
    messageId: z.string().regex(
      objectIdRegex,
      "Invalid message ID",
    ),
  }),
  query: z.object({}).optional(),
});

export type CreateUserMessageParams = z.infer<
  typeof createUserMessageSchema
>["params"];
export type CreateUserMessageBody = z.infer<
  typeof createUserMessageSchema
>["body"];
export type GetConversationMessagesParams = z.infer<
  typeof getConversationMessagesSchema
>["params"];
export type GetMessageByIdParams = z.infer<
  typeof getMessageByIdSchema
>["params"];
export type GetConversationMessagesQuery = z.infer<
  typeof getConversationMessagesSchema
>["query"];
