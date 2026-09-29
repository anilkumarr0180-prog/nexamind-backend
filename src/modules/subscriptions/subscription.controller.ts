import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as subscriptionService from "./subscription.service.js";
import { extractPolarErrorMessage } from "./subscription.service.js";
import * as billingCheckoutService from "./billing-checkout.service.js";
import { polarClient } from "../../config/polar.js";
import * as userRepository from "../users/user.repository.js";
import * as subscriptionRepository from "./subscription.repository.js";
import { env } from "../../config/env.js";

export const getMySubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const subscription =
    await subscriptionService.getCurrentSubscription(
      authUser.userId,
    );

  res.status(200).json({
    success: true,
    data: {
      subscription,
    },
  });
};

export const syncMySubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  await subscriptionService.syncUserSubscriptionWithPolar(authUser.userId);
  const subscription = await subscriptionService.getCurrentSubscription(authUser.userId);

  res.status(200).json({
    success: true,
    data: {
      subscription,
    },
    message: "Subscription status synchronized successfully.",
  });
};

export const upgradeSubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const { planCode, interval } = req.body;
  if (!planCode || !interval) {
    throw new AppError(
      "planCode and interval are required",
      400,
      "INVALID_INPUT",
    );
  }

  const result = await subscriptionService.upgradeSubscription(
    authUser.userId,
    planCode,
    interval,
  );

  res.status(200).json({
    success: true,
    data: result,
    message: `Successfully upgraded to ${planCode}! ${result.creditGrant > 0 ? `${result.creditGrant.toLocaleString()} credits added to your balance.` : ''}`.trim(),
  });
};

export const cancelSubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const subscription = await subscriptionService.cancelSubscription(
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: {
      subscription,
    },
    message: "Subscription auto-renewal has been cancelled. Plan remains active until period end.",
  });
};

export const resumeSubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const subscription = await subscriptionService.resumeSubscription(
    authUser.userId,
  );

  res.status(200).json({
    success: true,
    data: {
      subscription,
    },
    message: "Subscription auto-renewal has been successfully resumed.",
  });
};

export const createCheckoutSession = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const { planCode, interval } = req.body;

  const checkoutSession = await billingCheckoutService.createCheckoutSession({
    userId: authUser.userId,
    planCode,
    interval,
  });

  res.status(200).json({
    success: true,
    data: checkoutSession,
  });
};

/**
 * GET /api/v1/subscriptions/portal
 */
export const getPortalSession = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const [user, subscription] = await Promise.all([
    userRepository.findUserById(authUser.userId),
    subscriptionRepository.findCurrentSubscriptionByUserId(authUser.userId),
  ]);

  const frontendOrigin = env.CORS_ORIGINS[0] || "http://localhost:5173";
  const returnUrl = `${frontendOrigin}/app/settings`;

  // 1. Attempt to create authenticated customer session via Polar SDK
  try {
    let session;
    if (subscription?.providerCustomerId) {
      session = await polarClient.customerSessions.create({
        customerId: subscription.providerCustomerId,
        returnUrl,
      });
    } else {
      session = await polarClient.customerSessions.create({
        externalCustomerId: authUser.userId,
        returnUrl,
      });
    }

    if (session?.customerPortalUrl) {
      res.status(200).json({
        success: true,
        data: {
          portalUrl: session.customerPortalUrl,
        },
      });
      return;
    }
  } catch (error: unknown) {
    console.warn(
      "[SUBSCRIPTION] Pre-authenticated customer session unavailable, falling back to hosted customer portal:",
      extractPolarErrorMessage(error),
    );
  }

  // 2. Resilient fallback to Polar hosted customer portal for the organization
  const orgSlug = process.env.POLAR_ORGANIZATION_SLUG || "nexamind-ai";
  const polarPortalBase = `https://sandbox.polar.sh/${orgSlug}/portal`;
  const portalUrl = user?.email
    ? `${polarPortalBase}?email=${encodeURIComponent(user.email)}`
    : polarPortalBase;

  res.status(200).json({
    success: true,
    data: {
      portalUrl,
    },
  });
};
