import { z } from "zod";

export const createCheckoutSessionSchema = z.object({
  body: z
    .object({
      planCode: z.string().trim().min(1, "planCode is required"),
      interval: z.string().trim().min(1, "interval is required"),
    })
    .strict(),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});