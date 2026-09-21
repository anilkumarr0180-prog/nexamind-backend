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
 *
 * Creates a Polar customer portal session for the authenticated user and
 * returns the portal URL. The customer portal allows users to manage their
 * billing information, payment methods, and subscription details directly
 * through Polar's hosted interface.
 *
 * Uses externalCustomerId (= NexaMind userId) — consistent with checkout setup.
 * Never exposes the Polar access token or internal credentials.
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