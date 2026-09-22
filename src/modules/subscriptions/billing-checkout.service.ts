import { AppError } from "../../errors/app.error.js";
import { polarClient } from "../../config/polar.js";
import { env } from "../../config/env.js";
import { getProviderProductId } from "./billing-catalog.service.js";
import * as userRepository from "../users/user.repository.js";

export interface CreateCheckoutSessionInput {
  userId: string;
  planCode: string;
  interval: string;
}

export interface CheckoutSessionResult {
  checkoutUrl: string;
  checkoutId: string;
}

/**
 * Creates a Polar Checkout Session for the authenticated user and resolved product ID.
 * Automatically configures successUrl and returnUrl for seamless return and activation.
 */
export const createCheckoutSession = async (
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> => {
  const { userId, planCode, interval } = input;

  // 1. Resolve Polar Product ID from trusted backend billing catalog
  // This validates planCode, interval, rejects FREE, and resolves from env
  const providerProductId = getProviderProductId(planCode, interval);

  // 2. Fetch authenticated user to verify existence and prefill checkout details
  const user = await userRepository.findUserById(userId);
  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  // 3. Resolve frontend origin for redirects
  const frontendOrigin = env.CORS_ORIGINS[0] || "http://localhost:5173";
  const successUrl = `${frontendOrigin}/app/billing?success=true&plan=${planCode.toUpperCase()}&checkout_id={CHECKOUT_ID}`;
  const returnUrl = `${frontendOrigin}/app/billing`;

  // 4. Create Checkout Session with Polar SDK
  try {
    const checkout = await polarClient.checkouts.create({
      products: [providerProductId],
      metadata: {
        userId,
      },
      externalCustomerId: userId,
      customerEmail: user.email,
      customerName: user.name ?? undefined,
      successUrl,
      returnUrl,
    });

    return {
      checkoutUrl: checkout.url,
      checkoutId: checkout.id,
    };
  } catch (error: unknown) {
    console.error("Failed to create Polar checkout session:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "Failed to create checkout session with payment provider",
      502,
      "PAYMENT_PROVIDER_ERROR",
    );
  }
};
