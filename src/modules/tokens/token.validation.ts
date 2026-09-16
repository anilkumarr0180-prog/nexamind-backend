import { z } from "zod";

export const creditAmountSchema = z
  .number()
  .int("Credit amount must be an integer")
  .positive("Credit amount must be positive");

export const getBalanceSchema = z.object({
  params: z.object({}).strict().optional(),
  query: z.object({}).strict().optional(),
  body: z.object({}).strict().optional(),
});

export const deductCreditsSchema = z.object({
  params: z.object({}).strict().optional(),
  query: z.object({}).strict().optional(),
  body: z
    .object({
      amount: creditAmountSchema,
    })
    .strict(),
});

export type GetBalanceSchema = z.infer<typeof getBalanceSchema>;
export type DeductCreditsSchema = z.infer<typeof deductCreditsSchema>;
