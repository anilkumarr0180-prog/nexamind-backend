import type { PlanCode } from "../plans/plan.types.js";
import type {
  SubscriptionInterval,
  SubscriptionProvider,
} from "./subscription.types.js";

export const PAID_PLAN_CODES = ["PLUS", "PRO"] as const;

export type PaidPlanCode = (typeof PAID_PLAN_CODES)[number];

export interface BillingProductMapping {
  planCode: PaidPlanCode;
  interval: SubscriptionInterval;
  provider: SubscriptionProvider;
  providerProductId: string;
}
