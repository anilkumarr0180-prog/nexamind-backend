import { z } from "zod";
import { CONVERSATION_STATUSES } from "./conversation.model.js";
import { MAX_LIMIT } from "../../utils/pagination.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const getConversationsSchema = z.object({
  params: z.object({}).optional(),
  body: z.object({}).optional(),
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

export const createConversationSchema = z.object({
  params: z.object({}).optional(),
  body: z
    .object({
      title: z
        .string()
        .trim()
        .min(1, "Conversation title is required")
        .max(200, "Conversation title cannot exceed 200 characters"),
    })
    .strict(),
  query: z.object({}).optional(),
});

export const getConversationByIdSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const updateConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z
    .object({
      title: z
        .string()
        .trim()
        .min(1, "Conversation title cannot be empty")
        .max(200, "Conversation title cannot exceed 200 characters")
        .optional(),
      status: z
        .enum([
          CONVERSATION_STATUSES.ACTIVE,
          CONVERSATION_STATUSES.ARCHIVED,
        ])
        .optional(),
      activeLeafMessageId: z
        .string()
        .regex(objectIdRegex, "Invalid message ID")
        .nullable()
        .optional(),
    })
    .strict(),
  query: z.object({}).optional(),
});

export const archiveConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const unarchiveConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const deleteConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(
      objectIdRegex,
      "Invalid conversation ID",
    ),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export type CreateConversationBody = z.infer<
  typeof createConversationSchema
>["body"];
export type UpdateConversationParams = z.infer<
  typeof updateConversationSchema
>["params"];
export type UpdateConversationBody = z.infer<
  typeof updateConversationSchema
>["body"];
export type GetConversationByIdParams = z.infer<
  typeof getConversationByIdSchema
>["params"];
export type ArchiveConversationParams = z.infer<
  typeof archiveConversationSchema
>["params"];
export type UnarchiveConversationParams = z.infer<
  typeof unarchiveConversationSchema
>["params"];
export type DeleteConversationParams = z.infer<
  typeof deleteConversationSchema
>["params"];
export type GetConversationsQuery = z.infer<
  typeof getConversationsSchema
>["query"];
