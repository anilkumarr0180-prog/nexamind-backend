import { AppError } from "../../errors/app.error.js";
import * as planRepository from "./plan.repository.js";
import { PLAN_CODES } from "./plan.model.js";
import type { PlanCode } from "./plan.types.js";

export const getActivePlans = async () => {
  return planRepository.findActivePlans();
};

export const getPlanByCode = async (code: string) => {
  const normalizedCode = code.toUpperCase() as PlanCode;

  if (!Object.values(PLAN_CODES).includes(normalizedCode)) {
    throw new AppError(
      "Invalid plan code. Must be one of: FREE, PLUS, PRO",
      400,
      "INVALID_PLAN_CODE",
    );
  }

  const plan = await planRepository.findPlanByCode(normalizedCode);

  if (!plan) {
    throw new AppError(
      "Plan not found",
      404,
      "PLAN_NOT_FOUND",
    );
  }

  return plan;
};