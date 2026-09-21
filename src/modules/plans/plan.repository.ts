import { Plan, PLAN_CREDITS, type IPlan } from "./plan.model.js";
import type { PlanCode } from "./plan.types.js";

export const findActivePlans = async (): Promise<IPlan[]> => {
  return Plan.find({ active: true })
    .sort({ monthlyCredits: 1 })
    .lean<IPlan[]>();
};

export const findPlanByCode = async (
  code: PlanCode,
): Promise<IPlan | null> => {
  return Plan.findOne({ code, active: true }).lean<IPlan | null>();
};

export const findPlanById = async (
  planId: string,
): Promise<IPlan | null> => {
  return Plan.findOne({ _id: planId, active: true }).lean<IPlan | null>();
};

export const getPlanCreditsByCode = async (
  code: PlanCode,
): Promise<number> => {
  const plan = await findPlanByCode(code);
  return plan?.monthlyCredits ?? PLAN_CREDITS[code];
};

export const upsertPlanByCode = async (
  code: PlanCode,
  data: Omit<IPlan, keyof Document | "createdAt" | "updatedAt">,
): Promise<IPlan> => {
  return Plan.findOneAndUpdate(
    { code },
    { $set: data },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).lean<IPlan>() as Promise<IPlan>;
};