import * as subscriptionRepository from "./subscription.repository.js";
import { findPlanById } from "../plans/plan.repository.js";
import type {
  CreateSubscriptionData,
  UpdateSubscriptionData,
} from "./subscription.types.js";

export const getCurrentSubscription = async (
  userId: string,
) => {
  const subscription =
    await subscriptionRepository.findCurrentSubscriptionByUserId(userId);

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
    interval: subscription.interval,
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
  return subscriptionRepository.findSubscriptionByProviderId(
    providerSubscriptionId,
  );
};

export const createSubscription = async (
  data: CreateSubscriptionData,
) => {
  return subscriptionRepository.createSubscription(data);
};

export const updateSubscriptionByProviderId = async (
  providerSubscriptionId: string,
  data: UpdateSubscriptionData,
) => {
  return subscriptionRepository.updateSubscriptionByProviderId(
    providerSubscriptionId,
    data,
  );
};