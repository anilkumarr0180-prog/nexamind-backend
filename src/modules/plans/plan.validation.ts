import { z } from "zod";
import { PLAN_CODES } from "./plan.model.js";

export const getPlansSchema = z.object({
  params: z.object({}).optional(),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const getPlanByCodeSchema = z.object({
  params: z.object({
    code: z
      .string()
      .trim()
      .min(1, "Plan code is required")
      .max(20, "Plan code is too long")
      .transform((val) => val.toUpperCase())
      .refine(
        (val) =>
          (Object.values(PLAN_CODES) as string[]).includes(val),
        "Invalid plan code. Must be one of: FREE, PLUS, PRO",
      ),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

export type GetPlanByCodeParams = z.infer<
  typeof getPlanByCodeSchema
>["params"];