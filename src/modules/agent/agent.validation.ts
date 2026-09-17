import { z } from "zod";
import { MIN_ALLOWED_STEPS, MAX_ALLOWED_STEPS } from "./agent.service.js";

export const executeAgentSchema = z.object({
  params: z.object({}).optional(),
  query: z.object({}).optional(),
  body: z
    .object({
      task: z
        .string()
        .trim()
        .min(1, "Task is required and cannot be empty"),
      conversationId: z
        .string()
        .trim()
        .min(1, "conversationId cannot be empty")
        .optional(),
      systemPrompt: z
        .string()
        .trim()
        .min(1, "systemPrompt cannot be empty")
        .optional(),
      maxSteps: z
        .number()
        .int("maxSteps must be an integer")
        .min(MIN_ALLOWED_STEPS, `maxSteps must be at least ${MIN_ALLOWED_STEPS}`)
        .max(MAX_ALLOWED_STEPS, `maxSteps cannot exceed ${MAX_ALLOWED_STEPS}`)
        .optional(),
      context: z.record(z.string(), z.unknown()).optional(),
      stream: z.boolean().optional(),
    })
    .strict(),
});

export type ExecuteAgentBody = z.infer<typeof executeAgentSchema>["body"];
