import {
  findCurrentSubscriptionByUserId,
  findSubscriptionByProviderId,
} from "./subscription.repository.js";
import { findPlanById } from "../plans/plan.repository.js";

export const getCurrentSubscription = async (
  userId: string,
) => {
  const subscription =
    await findCurrentSubscriptionByUserId(userId);

  if (!subscription) {
    return null;
  }

  const plan = await findPlanById(
    subscription.planId.toString(),
  );

  return {
    id: subscription._id.toString(),
    status: subscription.status,
    provider: subscription.provider,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt,

    plan: plan
      ? {
          id: plan._id.toString(),
          code: plan.code,
          name: plan.name,
          description: plan.description,
          monthlyCredits: plan.monthlyCredits,
          features: plan.features,
        }
      : null,
  };
};

export const getSubscriptionByProviderId = async (
  providerSubscriptionId: string,
) => {
  return findSubscriptionByProviderId(
    providerSubscriptionId,
  );
};