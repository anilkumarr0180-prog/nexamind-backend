import type { PLAN_CODES } from "./plans.model.js";

export type PlanCode = (typeof PLAN_CODES)[keyof typeof PLAN_CODES];

export interface PlanFeatures {
  memory: boolean;
  agent: boolean;
  advancedModels: boolean;
}

export interface PlanData {
  code: PlanCode;
  name: string;
  description: string;
  monthlyCredits: number;
  features: PlanFeatures;
  active: boolean;
}
