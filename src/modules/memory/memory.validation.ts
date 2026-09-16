import { z } from "zod";
import { MEMORY_TYPES } from "./memory.model.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const createMemorySchema = z.object({
  params: z.object({}).optional(),
  query: z.object({}).optional(),
  body: z
    .object({
      type: z.enum([
        MEMORY_TYPES.FACT,
        MEMORY_TYPES.PREFERENCE,
        MEMORY_TYPES.GOAL,
        MEMORY_TYPES.INSTRUCTION,
      ]),
      content: z
        .string()
        .trim()
        .min(1, "Memory content is required")
        .max(2000, "Memory content cannot exceed 2000 characters"),
    })
    .strict(),
});

export const getMemoriesSchema = z.object({
  params: z.object({}).optional(),
  body: z.object({}).optional(),
  query: z
    .object({
      type: z
        .enum([
          MEMORY_TYPES.FACT,
          MEMORY_TYPES.PREFERENCE,
          MEMORY_TYPES.GOAL,
          MEMORY_TYPES.INSTRUCTION,
        ])
        .optional(),
    })
    .strict()
    .optional(),
});

export const getMemoryByIdSchema = z.object({
  params: z.object({
    memoryId: z.string().regex(objectIdRegex, "Invalid memory ID"),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const updateMemorySchema = z.object({
  params: z.object({
    memoryId: z.string().regex(objectIdRegex, "Invalid memory ID"),
  }),
  query: z.object({}).optional(),
  body: z
    .object({
      type: z
        .enum([
          MEMORY_TYPES.FACT,
          MEMORY_TYPES.PREFERENCE,
          MEMORY_TYPES.GOAL,
          MEMORY_TYPES.INSTRUCTION,
        ])
        .optional(),
      content: z
        .string()
        .trim()
        .min(1, "Memory content cannot be empty")
        .max(2000, "Memory content cannot exceed 2000 characters")
        .optional(),
    })
    .strict()
    .refine(
      (data) => data.type !== undefined || data.content !== undefined,
      "At least one field (type or content) must be provided for update",
    ),
});

export const deleteMemorySchema = z.object({
  params: z.object({
    memoryId: z.string().regex(objectIdRegex, "Invalid memory ID"),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export type CreateMemoryBody = z.infer<typeof createMemorySchema>["body"];
export type GetMemoriesQuery = z.infer<typeof getMemoriesSchema>["query"];
export type GetMemoryByIdParams = z.infer<typeof getMemoryByIdSchema>["params"];
export type UpdateMemoryParams = z.infer<typeof updateMemorySchema>["params"];
export type UpdateMemoryBody = z.infer<typeof updateMemorySchema>["body"];
export type DeleteMemoryParams = z.infer<typeof deleteMemorySchema>["params"];

export const extractedMemoryCandidateSchema = z
  .object({
    type: z.enum([
      MEMORY_TYPES.FACT,
      MEMORY_TYPES.PREFERENCE,
      MEMORY_TYPES.GOAL,
      MEMORY_TYPES.INSTRUCTION,
    ]),
    content: z
      .string()
      .trim()
      .min(1, "Memory content cannot be empty")
      .max(2000, "Memory content cannot exceed 2000 characters"),
  })
  .strict();

export const memoryExtractionResponseSchema = z
  .object({
    memories: z.array(extractedMemoryCandidateSchema),
  })
  .strict();

export type ExtractedMemoryCandidate = z.infer<
  typeof extractedMemoryCandidateSchema
>;
export type MemoryExtractionResponse = z.infer<
  typeof memoryExtractionResponseSchema
>;
