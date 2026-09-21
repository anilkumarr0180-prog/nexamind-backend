import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import { PLAN_CODES } from "../plans/plan.model.js";
import {
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
  type SubscriptionProvider,
} from "./subscription.types.js";
import {
  PAID_PLAN_CODES,
  type PaidPlanCode,
  type BillingProductMapping,
} from "./billing-catalog.types.js";

/**
 * Type-guard checking whether a plan code is a paid plan (PLUS, PRO).
 */
export const isPaidPlan = (planCode: string): planCode is PaidPlanCode => {
  return (PAID_PLAN_CODES as readonly string[]).includes(planCode);
};

/**
 * Type-guard checking whether an interval is supported (MONTHLY, YEARLY).
 */
export const isSupportedInterval = (
  interval: string,
): interval is SubscriptionInterval => {
  return (SUBSCRIPTION_INTERVALS as readonly string[]).includes(interval);
};

/**
 * Returns the active billing product mappings from trusted backend configuration.
 */
export const getBillingCatalog = (): BillingProductMapping[] => {
  return [
    {
      planCode: "PLUS",
      interval: "MONTHLY",
      provider: "POLAR",
      providerProductId: env.POLAR_PRODUCT_PLUS_MONTHLY,
    },
    {
      planCode: "PLUS",
      interval: "YEARLY",
      provider: "POLAR",
      providerProductId: env.POLAR_PRODUCT_PLUS_YEARLY,
    },
    {
      planCode: "PRO",
      interval: "MONTHLY",
      provider: "POLAR",
      providerProductId: env.POLAR_PRODUCT_PRO_MONTHLY,
    },
    {
      planCode: "PRO",
      interval: "YEARLY",
      provider: "POLAR",
      providerProductId: env.POLAR_PRODUCT_PRO_YEARLY,
    },
  ];
};

/**
 * Resolves a trusted provider product ID for a given plan code and billing interval.
 * FREE is rejected as it is internal-only.
 * Invalid combinations or unconfigured product IDs throw standard AppError instances.
 */
export const getProviderProductId = (
  planCode: string,
  interval: string,
): string => {
  const normalizedPlan = planCode?.trim().toUpperCase();
  const normalizedInterval = interval?.trim().toUpperCase();

  // 1. FREE plan is internal-only and has no provider product
  if (normalizedPlan === PLAN_CODES.FREE) {
    throw new AppError(
      "The FREE plan is internal-only and does not have a provider product ID",
      400,
      "FREE_PLAN_NO_PROVIDER_PRODUCT",
    );
  }

  // 2. Validate plan code
  if (!isPaidPlan(normalizedPlan)) {
    throw new AppError(
      `Unsupported plan '${planCode}'. Supported paid plans: ${PAID_PLAN_CODES.join(", ")}`,
      400,
      "INVALID_PLAN_CODE",
    );
  }

  // 3. Validate billing interval
  if (!isSupportedInterval(normalizedInterval)) {
    throw new AppError(
      `Unsupported billing interval '${interval}'. Supported intervals: ${SUBSCRIPTION_INTERVALS.join(", ")}`,
      400,
      "INVALID_BILLING_INTERVAL",
    );
  }

  // 4. Resolve provider product ID from trusted backend configuration
  let providerProductId: string | undefined;

  if (normalizedPlan === "PLUS" && normalizedInterval === "MONTHLY") {
    providerProductId = env.POLAR_PRODUCT_PLUS_MONTHLY;
  } else if (normalizedPlan === "PLUS" && normalizedInterval === "YEARLY") {
    providerProductId = env.POLAR_PRODUCT_PLUS_YEARLY;
  } else if (normalizedPlan === "PRO" && normalizedInterval === "MONTHLY") {
    providerProductId = env.POLAR_PRODUCT_PRO_MONTHLY;
  } else if (normalizedPlan === "PRO" && normalizedInterval === "YEARLY") {
    providerProductId = env.POLAR_PRODUCT_PRO_YEARLY;
  }

  if (!providerProductId || !providerProductId.trim()) {
    throw new AppError(
      `Provider product not configured for plan ${normalizedPlan} (${normalizedInterval})`,
      500,
      "BILLING_CONFIGURATION_ERROR",
    );
  }

  return providerProductId.trim();
};

/**
 * Reverse-lookup: resolves plan code and interval from a provider product ID (e.g. for incoming webhooks).
 */
export const resolvePlanByProviderProductId = (
  providerProductId: string,
): {
  planCode: PaidPlanCode;
  interval: SubscriptionInterval;
  provider: SubscriptionProvider;
} | null => {
  if (!providerProductId || !providerProductId.trim()) {
    return null;
  }

  const trimmedId = providerProductId.trim();
  const catalog = getBillingCatalog();

  const match = catalog.find((item) => item.providerProductId === trimmedId);
  if (!match) {
    return null;
  }

  return {
    planCode: match.planCode,
    interval: match.interval,
    provider: match.provider,
  };
};
