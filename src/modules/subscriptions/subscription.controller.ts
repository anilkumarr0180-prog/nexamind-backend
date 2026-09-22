import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as subscriptionService from "./subscription.service.js";
import * as billingCheckoutService from "./billing-checkout.service.js";
import { polarClient } from "../../config/polar.js";

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

  try {
    const session = await polarClient.customerSessions.create({
      externalCustomerId: authUser.userId,
    });

    res.status(200).json({
      success: true,
      data: {
        portalUrl: session.customerPortalUrl,
      },
    });
  } catch (error: unknown) {
    console.error("[SUBSCRIPTION] Failed to create customer portal session:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "Failed to create customer portal session",
      502,
      "PAYMENT_PROVIDER_ERROR",
    );
  }
};
