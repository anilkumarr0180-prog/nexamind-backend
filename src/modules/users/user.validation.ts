import { z } from "zod";

export const getUserByIdSchema = z.object({
  body: z.object({}).optional(),
  params: z.object({
    userId: z.string().regex(
      /^[0-9a-fA-F]{24}$/,
      "Invalid user ID",
    ),
  }),
  query: z.object({}).optional(),
});