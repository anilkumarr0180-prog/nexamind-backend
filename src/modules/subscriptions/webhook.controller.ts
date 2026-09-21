import type { Request, Response, NextFunction } from "express";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app.error.js";
import { handleVerifiedEvent } from "./webhook.service.js";

/**
 * Handles inbound Polar webhook events.
 *
 * SECURITY:
 * - This route is mounted BEFORE global express.json() so the raw body
 *   Buffer is preserved for HMAC-SHA256 signature verification.
 * - express.raw({ type: "application/json" }) is applied at the route level.
 * - No JWT authentication — cryptographic signature verification is the
 *   security control for this endpoint.
 * - The raw body and webhook secret are never logged.
 * - No business logic runs before signature verification passes.
 *
 * Flow:
 * 1. Validate required Standard Webhooks headers
 * 2. Validate raw body is a Buffer
 * 3. Verify Polar signature with validateEvent()
 * 4. Pass verified event to webhook service (idempotency + dispatch)
 * 5. Return 202 Accepted
 */
export const polarWebhookHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const webhookId = req.headers["webhook-id"];
  const webhookTimestamp = req.headers["webhook-timestamp"];
  const webhookSignature = req.headers["webhook-signature"];

  /**
   * Validate required Standard Webhooks headers.
   */
  if (
    typeof webhookId !== "string" ||
    typeof webhookTimestamp !== "string" ||
    typeof webhookSignature !== "string"
  ) {
    next(
      new AppError(
        "Missing or invalid webhook signature headers",
        400,
        "WEBHOOK_HEADERS_INVALID",
      ),
    );
    return;
  }

  /**
   * express.raw() must give us the original request body as a Buffer.
   * Never JSON.parse() before signature verification.
   */
  if (!Buffer.isBuffer(req.body)) {
    next(
      new AppError(
        "Webhook body must be a raw Buffer",
        400,
        "WEBHOOK_BODY_INVALID",
      ),
    );
    return;
  }

  const rawBody = req.body;

  let verifiedEvent: ReturnType<typeof validateEvent>;

  try {
    /**
     * Verify the Polar HMAC-SHA256 signature.
     *
     * We pass only the three validated header values, not the full
     * Express IncomingHttpHeaders object, to reduce the attack surface.
     *
     * DO NOT bypass or remove this call.
     * DO NOT trust the payload before this succeeds.
     */
    verifiedEvent = validateEvent(
      rawBody,
      {
        "webhook-id": webhookId,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": webhookSignature,
      },
      env.POLAR_WEBHOOK_SECRET,
    );
  } catch (error: unknown) {
    if (error instanceof WebhookVerificationError) {
      next(
        new AppError(
          "Webhook signature verification failed",
          403,
          "WEBHOOK_SIGNATURE_INVALID",
        ),
      );
      return;
    }

    next(error);
    return;
  }

  /**
   * Signature verified. Hand off to the service layer for:
   * - Idempotency checking (WebhookEvent DB record)
   * - Event dispatching
   * - Subscription synchronization
   * - Credit grants
   */
  handleVerifiedEvent(webhookId, verifiedEvent)
    .then(() => {
      res.status(202).send();
    })
    .catch((error: unknown) => {
      next(error);
    });
};