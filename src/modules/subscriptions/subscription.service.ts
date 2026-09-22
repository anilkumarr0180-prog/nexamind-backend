import { Types } from "mongoose";
import * as subscriptionRepository from "./subscription.repository.js";
import { findPlanById, findPlanByCode } from "../plans/plan.repository.js";
import { getProviderProductId, resolvePlanByProviderProductId } from "./billing-catalog.service.js";
import * as tokenRepository from "../tokens/token.repository.js";
import * as creditTransactionRepository from "../credit-transactions/credit-transaction.repository.js";
import * as userRepository from "../users/user.repository.js";
import { Subscription } from "./subscription.model.js";
import { polarClient } from "../../config/polar.js";
import { AppError } from "../../errors/app.error.js";
import type {
  CreateSubscriptionData,
  UpdateSubscriptionData,
  SubscriptionInterval,
  SubscriptionStatus,
} from "./subscription.types.js";
import type { PlanCode } from "../plans/plan.types.js";

/**
 * Automatically synchronizes an active subscription from Polar to MongoDB
 * if the user has subscribed via Polar but webhooks were delayed or dropped.
 */
export const syncUserSubscriptionWithPolar = async (userId: string) => {
  const user = await userRepository.findUserById(userId);
  if (!user) return null;

  try {
    const polarSubs = await polarClient.subscriptions.list({ limit: 20 });
    const match = polarSubs.result.items.find(
      (s) =>
        s.customer?.externalId === userId ||
        s.customer?.email?.toLowerCase() === user.email.toLowerCase(),
    );

    if (match && (match.status === "active" || match.status === "trialing")) {
      const planInfo = resolvePlanByProviderProductId(match.productId);
      const plan = planInfo ? await findPlanByCode(planInfo.planCode) : null;

      if (plan) {
        await Subscription.findOneAndUpdate(
          { providerSubscriptionId: match.id },
          {
            $set: {
              userId: new Types.ObjectId(userId),
              planId: plan._id,
              provider: "POLAR",
              providerSubscriptionId: match.id,
              providerCustomerId: match.customer?.id ?? "",
              providerProductId: match.productId,
              interval: (planInfo?.interval ?? "MONTHLY") as SubscriptionInterval,
              status: match.status.toUpperCase() as SubscriptionStatus,
              currentPeriodStart: new Date(match.currentPeriodStart),
              currentPeriodEnd: new Date(match.currentPeriodEnd),
              cancelAtPeriodEnd: Boolean(match.cancelAtPeriodEnd),
              canceledAt: match.canceledAt ? new Date(match.canceledAt) : null,
              endedAt: match.endedAt ? new Date(match.endedAt) : null,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          { upsert: true, returnDocument: "after" },
        );

        // Grant plan credits idempotently
        const refId = `polar_sub_${match.id}_initial_grant`;
        const existingTx =
          await creditTransactionRepository.findCreditTransactionByReferenceId(refId);

        if (!existingTx && plan.monthlyCredits > 0) {
          const balanceBeforeRecord =
            await tokenRepository.findTokenBalanceByUserId(userId);
          const balanceBefore = balanceBeforeRecord?.balance ?? 0;

          const updatedBalance = await tokenRepository.atomicAddBalance(
            userId,
            plan.monthlyCredits,
          );
          const balanceAfter =
            updatedBalance?.balance ?? balanceBefore + plan.monthlyCredits;

          await creditTransactionRepository.createCreditTransaction({
            userId: new Types.ObjectId(userId),
            type: "PLAN_GRANT",
            amount: plan.monthlyCredits,
            balanceBefore,
            balanceAfter,
            referenceId: refId,
            description: `Initial ${plan.name} plan credit grant`,
          });
          console.log(
            `[SUBSCRIPTION SYNC] Granted ${plan.monthlyCredits} credits to user ${userId} for sub ${match.id}`,
          );
        }
      }
    }
  } catch (err) {
    console.warn("[SUBSCRIPTION SYNC] Polar sync warning:", err);
  }

  return null;
};

export const getCurrentSubscription = async (
  userId: string,
) => {
  let subscription =
    await subscriptionRepository.findCurrentSubscriptionByUserId(userId);

  // If no active subscription is in MongoDB, attempt on-demand Polar sync
  if (!subscription) {
    await syncUserSubscriptionWithPolar(userId);
    subscription =
      await subscriptionRepository.findCurrentSubscriptionByUserId(userId);
  }

  if (!subscription) {
    return null;
  }

  const plan = await findPlanById(
    subscription.planId.toString(),
  );

  return {
    id: subscription._id.toString(),
    planCode: plan ? plan.code : "FREE",
    status: subscription.status,
    provider: subscription.provider,
    interval: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
    canceledAt: subscription.canceledAt ?? null,
    endedAt: subscription.endedAt ?? null,

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

export const upgradeSubscription = async (
  userId: string,
  targetPlanCode: string,
  targetInterval: string,
) => {
  const subscription =
    await subscriptionRepository.findCurrentSubscriptionByUserId(userId);

  if (!subscription) {
    throw new AppError(
      "No active subscription found to upgrade. Please subscribe via checkout first.",
      400,
      "NO_ACTIVE_SUBSCRIPTION",
    );
  }

  const normalizedPlanCode = targetPlanCode.trim().toUpperCase() as PlanCode;
  const normalizedInterval = targetInterval.trim().toUpperCase() as SubscriptionInterval;

  const currentPlan = await findPlanById(subscription.planId.toString());
  const newPlan = await findPlanByCode(normalizedPlanCode);

  if (!newPlan) {
    throw new AppError(
      `Target plan '${targetPlanCode}' not found`,
      404,
      "PLAN_NOT_FOUND",
    );
  }

  if (
    currentPlan?.code === normalizedPlanCode &&
    subscription.interval === normalizedInterval
  ) {
    return {
      subscription: await getCurrentSubscription(userId),
      creditGrant: 0,
    };
  }

  const newProviderProductId = getProviderProductId(
    normalizedPlanCode,
    normalizedInterval,
  );

  if (subscription.provider === "POLAR" && subscription.providerSubscriptionId) {
    try {
      await polarClient.subscriptions.update({
        id: subscription.providerSubscriptionId,
        subscriptionUpdate: {
          productId: newProviderProductId,
          prorationBehavior: "invoice",
        },
      });
      console.log(
        `[SUBSCRIPTION] Polar subscription ${subscription.providerSubscriptionId} upgraded to ${newProviderProductId} with invoice proration`,
      );
    } catch (polarError: any) {
      console.warn(
        "[SUBSCRIPTION] Polar upgrade API warning:",
        polarError?.message || polarError,
      );
    }
  }

  await subscriptionRepository.updateSubscriptionById(
    subscription._id.toString(),
    {
      planId: newPlan._id,
      providerProductId: newProviderProductId,
      interval: normalizedInterval,
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  );

  const currentCredits = currentPlan?.monthlyCredits ?? 0;
  const newCredits = newPlan.monthlyCredits ?? 0;
  const creditDiff = Math.max(0, newCredits - currentCredits);

  if (creditDiff > 0) {
    const balanceBeforeRecord =
      await tokenRepository.findTokenBalanceByUserId(userId);
    const balanceBefore = balanceBeforeRecord?.balance ?? 0;

    const updatedBalance = await tokenRepository.atomicAddBalance(
      userId,
      creditDiff,
    );
    const balanceAfter =
      updatedBalance?.balance ?? balanceBefore + creditDiff;

    await creditTransactionRepository.createCreditTransaction({
      userId: new Types.ObjectId(userId),
      type: "PLAN_GRANT",
      amount: creditDiff,
      balanceBefore,
      balanceAfter,
      referenceId: `upgrade_${subscription._id}_${normalizedPlanCode}_${Date.now()}`,
      description: `Plan upgrade from ${currentPlan?.name ?? "Previous"} to ${newPlan.name} credit grant`,
    });
  }

  const updated = await getCurrentSubscription(userId);
  return {
    subscription: updated,
    creditGrant: creditDiff,
  };
};

export const cancelSubscription = async (userId: string) => {
  const subscription =
    await subscriptionRepository.findCurrentSubscriptionByUserId(userId);

  if (!subscription) {
    throw new AppError("No active subscription found to cancel", 404, "SUBSCRIPTION_NOT_FOUND");
  }

  if (subscription.cancelAtPeriodEnd) {
    return getCurrentSubscription(userId);
  }

  if (subscription.provider === "POLAR" && subscription.providerSubscriptionId) {
    try {
      await polarClient.subscriptions.update({
        id: subscription.providerSubscriptionId,
        subscriptionUpdate: {
          cancelAtPeriodEnd: true,
        },
      });
      console.log(`[SUBSCRIPTION] Polar subscription ${subscription.providerSubscriptionId} set to cancel at period end`);
    } catch (polarError) {
      console.warn("[SUBSCRIPTION] Polar cancel update warning (persisting locally):", polarError);
    }
  }

  await subscriptionRepository.updateSubscriptionById(
    subscription._id.toString(),
    {
      cancelAtPeriodEnd: true,
      canceledAt: new Date(),
    },
  );

  return getCurrentSubscription(userId);
};

export const resumeSubscription = async (userId: string) => {
  const subscription =
    await subscriptionRepository.findCurrentSubscriptionByUserId(userId);

  if (!subscription) {
    throw new AppError("No active subscription found to resume", 404, "SUBSCRIPTION_NOT_FOUND");
  }

  if (!subscription.cancelAtPeriodEnd) {
    return getCurrentSubscription(userId);
  }

  if (subscription.provider === "POLAR" && subscription.providerSubscriptionId) {
    try {
      await polarClient.subscriptions.update({
        id: subscription.providerSubscriptionId,
        subscriptionUpdate: {
          cancelAtPeriodEnd: false,
        },
      });
      console.log(`[SUBSCRIPTION] Polar subscription ${subscription.providerSubscriptionId} resumed (cancelAtPeriodEnd: false)`);
    } catch (polarError) {
      console.warn("[SUBSCRIPTION] Polar resume update warning (persisting locally):", polarError);
    }
  }

  await subscriptionRepository.updateSubscriptionById(
    subscription._id.toString(),
    {
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  );

  return getCurrentSubscription(userId);
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
