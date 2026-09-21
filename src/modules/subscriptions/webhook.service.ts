import mongoose, { Types } from "mongoose";
import type { Subscription as PolarSubscription } from "@polar-sh/sdk/models/components/subscription.js";
import type { Order as PolarOrder } from "@polar-sh/sdk/models/components/order.js";
import { AppError } from "../../errors/app.error.js";
import * as webhookEventRepository from "./webhook-event.repository.js";
import * as subscriptionRepository from "./subscription.repository.js";
import * as tokenRepository from "../tokens/token.repository.js";
import * as creditTransactionRepository from "../credit-transactions/credit-transaction.repository.js";
import * as planRepository from "../plans/plan.repository.js";
import { resolvePlanByProviderProductId } from "./billing-catalog.service.js";
import type { SubscriptionInterval, SubscriptionStatus } from "./subscription.types.js";
import type { PlanCode } from "../plans/plan.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a Polar `RecurringInterval` string to the NexaMind internal interval.
 * Polar values: "month" | "year" | "day" | "week"
 */
const mapInterval = (polarInterval: string): SubscriptionInterval => {
  if (polarInterval === "year") return "YEARLY";
  if (polarInterval !== "month") {
    console.warn(
      `[WEBHOOK] Unexpected Polar recurringInterval "${polarInterval}". Defaulting to MONTHLY.`,
    );
  }
  return "MONTHLY";
};

/**
 * Maps a Polar subscription status string to the NexaMind internal status.
 * Polar statuses: active | trialing | past_due | canceled | incomplete |
 *                 incomplete_expired | unpaid | paused
 */
const mapSubscriptionStatus = (polarStatus: string): SubscriptionStatus => {
  switch (polarStatus) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "unpaid":
      return "UNPAID";
    default:
      // paused or unknown — treat as INCOMPLETE so access is not granted
      console.warn(
        `[WEBHOOK] Unknown Polar status "${polarStatus}". Mapping to INCOMPLETE.`,
      );
      return "INCOMPLETE";
  }
};

/**
 * Extracts the NexaMind userId from a Polar subscription's customer.externalId.
 * This was set as `externalCustomerId = userId` at checkout creation time.
 */
const extractUserIdFromSubscription = (
  polarSub: PolarSubscription,
): string | null => {
  const externalId = polarSub.customer?.externalId;
  if (!externalId || !externalId.trim()) return null;
  if (!Types.ObjectId.isValid(externalId.trim())) return null;
  return externalId.trim();
};

/**
 * Extracts the NexaMind userId from a Polar order's customer.externalId.
 */
const extractUserIdFromOrder = (polarOrder: PolarOrder): string | null => {
  const externalId = polarOrder.customer?.externalId;
  if (!externalId || !externalId.trim()) return null;
  if (!Types.ObjectId.isValid(externalId.trim())) return null;
  return externalId.trim();
};

// ---------------------------------------------------------------------------
// Credit grant (atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically grants plan credits to a user.
 *
 * Uses MongoDB session/transaction to ensure TokenBalance update and
 * CreditTransaction creation are atomic. The unique index on
 * CreditTransaction.{userId, type, referenceId} guarantees that a duplicate
 * referenceId results in a MongoServerError with code 11000, which we catch
 * and treat as a no-op (idempotent by design).
 */
const grantPlanCredits = async (
  userId: string,
  planCode: PlanCode,
  referenceId: string,
  description: string,
): Promise<void> => {
  // Resolve credits from Plan (canonical source of truth)
  const creditAmount = await planRepository.getPlanCreditsByCode(planCode);

  if (
    typeof creditAmount !== "number" ||
    !Number.isFinite(creditAmount) ||
    !Number.isInteger(creditAmount) ||
    creditAmount <= 0
  ) {
    throw new AppError(
      `Invalid credit amount resolved for plan ${planCode}: ${creditAmount}`,
      500,
      "INVALID_CREDIT_AMOUNT",
    );
  }

  const userObjectId = new Types.ObjectId(userId);
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Read-lock the current balance inside the transaction
      const currentBalance =
        await tokenRepository.findTokenBalanceByUserId(userObjectId, session);

      if (!currentBalance) {
        throw new AppError(
          `TokenBalance not found for user ${userId}. Cannot grant credits.`,
          404,
          "TOKEN_BALANCE_NOT_FOUND",
        );
      }

      const balanceBefore = currentBalance.balance;

      // Atomically increment the balance
      const updated = await tokenRepository.atomicAddBalanceWithSession(
        userObjectId,
        creditAmount,
        session,
      );

      if (!updated) {
        throw new AppError(
          `Failed to update TokenBalance for user ${userId}`,
          500,
          "TOKEN_BALANCE_UPDATE_FAILED",
        );
      }

      const balanceAfter = updated.balance;

      // Create immutable audit ledger entry.
      // The unique index on {userId, type, referenceId} will reject duplicates
      // with a MongoServerError code 11000 — caught below at the caller level.
      await creditTransactionRepository.createCreditTransaction(
        {
          userId: userObjectId,
          type: "PLAN_GRANT",
          amount: creditAmount,
          balanceBefore,
          balanceAfter,
          referenceId,
          description,
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
};

// ---------------------------------------------------------------------------
// Individual event handlers
// ---------------------------------------------------------------------------

/**
 * Handles `subscription.active`.
 *
 * 1. Resolves the NexaMind user from the Polar customer externalId.
 * 2. Resolves the plan from the provider product ID via billing catalog.
 * 3. Upserts the internal Subscription document.
 * 4. Grants initial plan credits exactly once (idempotent via referenceId).
 */
const handleSubscriptionActive = async (
  polarSub: PolarSubscription,
): Promise<void> => {
  const userId = extractUserIdFromSubscription(polarSub);
  if (!userId) {
    console.warn(
      "[WEBHOOK] subscription.active: could not resolve userId from customer.externalId. Skipping.",
    );
    return;
  }

  const catalogMatch = resolvePlanByProviderProductId(polarSub.productId);
  if (!catalogMatch) {
    console.warn(
      `[WEBHOOK] subscription.active: productId "${polarSub.productId}" not found in billing catalog. Skipping.`,
    );
    return;
  }

  // Resolve the internal Plan document
  const plan = await planRepository.findPlanByCode(catalogMatch.planCode);
  if (!plan) {
    throw new AppError(
      `Plan "${catalogMatch.planCode}" not found in database`,
      500,
      "PLAN_NOT_FOUND",
    );
  }

  const interval = mapInterval(polarSub.recurringInterval);
  const status = mapSubscriptionStatus(polarSub.status);

  const existingSubscription =
    await subscriptionRepository.findSubscriptionByProviderId(polarSub.id);

  if (existingSubscription) {
    // Update the existing subscription
    await subscriptionRepository.updateSubscriptionByProviderId(polarSub.id, {
      planId: plan._id,
      providerProductId: polarSub.productId,
      interval,
      status,
      currentPeriodStart: polarSub.currentPeriodStart,
      currentPeriodEnd: polarSub.currentPeriodEnd,
      cancelAtPeriodEnd: polarSub.cancelAtPeriodEnd,
      canceledAt: polarSub.canceledAt ?? null,
      endedAt: polarSub.endedAt ?? null,
    });
  } else {
    // Create a new subscription
    await subscriptionRepository.createSubscription({
      userId: new Types.ObjectId(userId),
      planId: plan._id,
      provider: "POLAR",
      providerSubscriptionId: polarSub.id,
      providerCustomerId: polarSub.customerId,
      providerProductId: polarSub.productId,
      interval,
      status,
      currentPeriodStart: polarSub.currentPeriodStart,
      currentPeriodEnd: polarSub.currentPeriodEnd,
      cancelAtPeriodEnd: polarSub.cancelAtPeriodEnd,
      canceledAt: polarSub.canceledAt ?? null,
      endedAt: polarSub.endedAt ?? null,
    });
  }

  // Grant initial plan credits exactly once.
  // The referenceId is deterministic: a duplicate delivery of the same
  // subscription.active cannot produce a second credit grant.
  const initialGrantRef = `polar_sub_${polarSub.id}_initial_grant`;

  try {
    await grantPlanCredits(
      userId,
      catalogMatch.planCode,
      initialGrantRef,
      `Initial ${catalogMatch.planCode} plan credit grant`,
    );

    console.log(
      `[WEBHOOK] subscription.active: granted ${catalogMatch.planCode} credits to user ${userId} (ref: ${initialGrantRef})`,
    );
  } catch (error: unknown) {
    // MongoDB duplicate key (11000) means the grant already exists — idempotent, safe to ignore
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      console.log(
        `[WEBHOOK] subscription.active: initial grant already exists for ref "${initialGrantRef}" — skipping duplicate.`,
      );
      return;
    }

    throw error;
  }
};

/**
 * Handles `subscription.canceled`.
 *
 * Updates the subscription status and cancellation metadata.
 * Does NOT immediately revoke access if cancelAtPeriodEnd is true.
 */
const handleSubscriptionCanceled = async (
  polarSub: PolarSubscription,
): Promise<void> => {
  const existing =
    await subscriptionRepository.findSubscriptionByProviderId(polarSub.id);

  if (!existing) {
    console.warn(
      `[WEBHOOK] subscription.canceled: no subscription found for Polar ID "${polarSub.id}". Skipping.`,
    );
    return;
  }

  await subscriptionRepository.updateSubscriptionByProviderId(polarSub.id, {
    status: mapSubscriptionStatus(polarSub.status),
    cancelAtPeriodEnd: polarSub.cancelAtPeriodEnd,
    canceledAt: polarSub.canceledAt ?? null,
    currentPeriodStart: polarSub.currentPeriodStart,
    currentPeriodEnd: polarSub.currentPeriodEnd,
    endedAt: polarSub.endedAt ?? null,
  });

  console.log(
    `[WEBHOOK] subscription.canceled: updated subscription "${polarSub.id}" (cancelAtPeriodEnd: ${polarSub.cancelAtPeriodEnd})`,
  );
};

/**
 * Handles `subscription.uncanceled`.
 *
 * Restores the subscription to its active/trialing state.
 * Does NOT re-grant credits — the initial grant already happened.
 */
const handleSubscriptionUncanceled = async (
  polarSub: PolarSubscription,
): Promise<void> => {
  const existing =
    await subscriptionRepository.findSubscriptionByProviderId(polarSub.id);

  if (!existing) {
    console.warn(
      `[WEBHOOK] subscription.uncanceled: no subscription found for Polar ID "${polarSub.id}". Skipping.`,
    );
    return;
  }

  await subscriptionRepository.updateSubscriptionByProviderId(polarSub.id, {
    status: mapSubscriptionStatus(polarSub.status),
    cancelAtPeriodEnd: polarSub.cancelAtPeriodEnd,
    canceledAt: polarSub.canceledAt ?? null,
    currentPeriodStart: polarSub.currentPeriodStart,
    currentPeriodEnd: polarSub.currentPeriodEnd,
    endedAt: polarSub.endedAt ?? null,
  });

  console.log(
    `[WEBHOOK] subscription.uncanceled: subscription "${polarSub.id}" restored to ${polarSub.status}`,
  );
};

/**
 * Handles `subscription.past_due`.
 *
 * Updates the internal status to PAST_DUE.
 * Does NOT delete credits — Polar handles payment recovery.
 */
const handleSubscriptionPastDue = async (
  polarSub: PolarSubscription,
): Promise<void> => {
  const existing =
    await subscriptionRepository.findSubscriptionByProviderId(polarSub.id);

  if (!existing) {
    console.warn(
      `[WEBHOOK] subscription.past_due: no subscription found for Polar ID "${polarSub.id}". Skipping.`,
    );
    return;
  }

  await subscriptionRepository.updateSubscriptionByProviderId(polarSub.id, {
    status: "PAST_DUE",
    currentPeriodStart: polarSub.currentPeriodStart,
    currentPeriodEnd: polarSub.currentPeriodEnd,
  });

  console.log(
    `[WEBHOOK] subscription.past_due: subscription "${polarSub.id}" marked PAST_DUE`,
  );
};

/**
 * Handles `subscription.revoked`.
 *
 * Sets the subscription to REVOKED and records endedAt.
 * Paid access must no longer be treated as active.
 * Does not modify credits — no expiration mechanism exists yet.
 */
const handleSubscriptionRevoked = async (
  polarSub: PolarSubscription,
): Promise<void> => {
  const existing =
    await subscriptionRepository.findSubscriptionByProviderId(polarSub.id);

  if (!existing) {
    console.warn(
      `[WEBHOOK] subscription.revoked: no subscription found for Polar ID "${polarSub.id}". Skipping.`,
    );
    return;
  }

  await subscriptionRepository.updateSubscriptionByProviderId(polarSub.id, {
    status: "REVOKED",
    endedAt: polarSub.endedAt ?? new Date(),
    canceledAt: polarSub.canceledAt ?? null,
    cancelAtPeriodEnd: false,
  });

  console.log(
    `[WEBHOOK] subscription.revoked: subscription "${polarSub.id}" set to REVOKED`,
  );
};

/**
 * Handles `order.paid`.
 *
 * Only grants credits when billingReason === "subscription_cycle" (renewal).
 * Other billing reasons (purchase, subscription_create, subscription_update)
 * are handled by subscription.active or are not credit-relevant.
 *
 * Idempotent: the referenceId `polar_order_{orderId}_renewal_grant` plus
 * the unique CreditTransaction index prevents duplicate grants.
 */
const handleOrderPaid = async (polarOrder: PolarOrder): Promise<void> => {
  // Only process subscription renewal orders
  if (polarOrder.billingReason !== "subscription_cycle") {
    console.log(
      `[WEBHOOK] order.paid: billingReason="${polarOrder.billingReason}" — not a renewal. Skipping credit grant.`,
    );
    return;
  }

  if (!polarOrder.subscriptionId) {
    console.warn(
      `[WEBHOOK] order.paid: subscription_cycle order "${polarOrder.id}" has no subscriptionId. Skipping.`,
    );
    return;
  }

  const userId = extractUserIdFromOrder(polarOrder);
  if (!userId) {
    console.warn(
      `[WEBHOOK] order.paid: could not resolve userId from customer.externalId for order "${polarOrder.id}". Skipping.`,
    );
    return;
  }

  // Find the internal subscription to determine the plan
  const internalSub = await subscriptionRepository.findSubscriptionByProviderId(
    polarOrder.subscriptionId,
  );

  if (!internalSub) {
    console.warn(
      `[WEBHOOK] order.paid: no internal subscription for Polar ID "${polarOrder.subscriptionId}". Skipping.`,
    );
    return;
  }

  // Resolve the plan from the subscription's planId
  const plan = await planRepository.findPlanById(internalSub.planId.toString());
  if (!plan) {
    throw new AppError(
      `Plan not found for subscription "${internalSub._id.toString()}"`,
      500,
      "PLAN_NOT_FOUND",
    );
  }

  const renewalGrantRef = `polar_order_${polarOrder.id}_renewal_grant`;

  try {
    await grantPlanCredits(
      userId,
      plan.code as PlanCode,
      renewalGrantRef,
      `${plan.code} plan renewal credit grant`,
    );

    console.log(
      `[WEBHOOK] order.paid: renewal grant for user ${userId} plan ${plan.code} (ref: ${renewalGrantRef})`,
    );
  } catch (error: unknown) {
    // Duplicate key → grant already exists → idempotent
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      console.log(
        `[WEBHOOK] order.paid: renewal grant already exists for ref "${renewalGrantRef}" — skipping duplicate.`,
      );
      return;
    }

    throw error;
  }
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Processes a Polar webhook event that has already passed signature verification.
 *
 * Implements two-layer idempotency:
 * 1. WebhookEvent DB record (unique on {provider, eventId}) — survives restarts
 * 2. CreditTransaction unique index on {userId, type, referenceId} — prevents
 *    duplicate credit grants even if processing runs concurrently
 *
 * Supported events:
 *   subscription.active, subscription.canceled, subscription.uncanceled,
 *   subscription.past_due, subscription.revoked, order.paid
 *
 * Unsupported events are marked SKIPPED without crashing.
 */
export const handleVerifiedEvent = async (
  webhookId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifiedEvent: { type: string; data: any },
): Promise<void> => {
  // Layer 1: Check if this event was already processed (survives restarts)
  const existing = await webhookEventRepository.findWebhookEvent(
    "POLAR",
    webhookId,
  );

  if (existing) {
    if (existing.status === "PROCESSED" || existing.status === "SKIPPED") {
      console.log(
        `[WEBHOOK] Event "${webhookId}" already ${existing.status}. Returning idempotent 202.`,
      );
      return;
    }

    if (existing.status === "PENDING") {
      // A previous attempt started but did not finish — allow reprocessing
      console.warn(
        `[WEBHOOK] Event "${webhookId}" was left in PENDING state. Reprocessing.`,
      );
    }

    // FAILED events: allow retry
  }

  // Create (or locate) the PENDING record
  let webhookRecord = existing;

  if (!webhookRecord) {
    try {
      webhookRecord = await webhookEventRepository.createWebhookEvent({
        provider: "POLAR",
        eventId: webhookId,
        eventType: verifiedEvent.type,
        receivedAt: new Date(),
      });
    } catch (error: unknown) {
      // Duplicate key on createWebhookEvent means a concurrent request already
      // inserted this event — treat as already-processing, safe to ignore
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === 11000
      ) {
        console.log(
          `[WEBHOOK] Concurrent insert for event "${webhookId}" — already being processed.`,
        );
        return;
      }
      throw error;
    }
  }

  const recordId = webhookRecord._id.toString();
  const eventType = verifiedEvent.type;

  try {
    switch (eventType) {
      case "subscription.active":
        await handleSubscriptionActive(verifiedEvent.data as PolarSubscription);
        break;

      case "subscription.canceled":
        await handleSubscriptionCanceled(verifiedEvent.data as PolarSubscription);
        break;

      case "subscription.uncanceled":
        await handleSubscriptionUncanceled(verifiedEvent.data as PolarSubscription);
        break;

      case "subscription.past_due":
        await handleSubscriptionPastDue(verifiedEvent.data as PolarSubscription);
        break;

      case "subscription.revoked":
        await handleSubscriptionRevoked(verifiedEvent.data as PolarSubscription);
        break;

      case "order.paid":
        await handleOrderPaid(verifiedEvent.data as PolarOrder);
        break;

      default:
        // Unsupported but valid Polar event — log and mark skipped
        console.log(
          `[WEBHOOK] Unsupported event type "${eventType}" — marking SKIPPED.`,
        );
        await webhookEventRepository.markWebhookEventSkipped(recordId);
        return;
    }

    await webhookEventRepository.markWebhookEventProcessed(recordId);
  } catch (error: unknown) {
    const reason =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

    console.error(
      `[WEBHOOK] Failed to process event "${webhookId}" (${eventType}): ${reason}`,
    );

    await webhookEventRepository.markWebhookEventFailed(recordId, reason);

    // Re-throw so the controller can respond with 500 if needed.
    // Polar will retry the delivery on 5xx responses.
    throw error;
  }
};
