import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const chatRequestSchema = z.object({
  params: z.object({}).strict().optional(),
  query: z.object({}).strict().optional(),
  body: z
    .object({
      conversationId: z
        .string()
        .regex(objectIdRegex, "Invalid conversation ID"),
      content: z
        .string()
        .trim()
        .min(1, "Message content is required")
        .max(100000, "Message content cannot exceed 100,000 characters"),
      stream: z.boolean().optional(),
      editMessageId: z
        .string()
        .regex(objectIdRegex, "Invalid message ID")
        .optional(),
      attachmentId: z
        .string()
        .regex(objectIdRegex, "Invalid attachment ID")
        .nullable()
        .optional(),
    })
    .strict(),
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>["body"];
