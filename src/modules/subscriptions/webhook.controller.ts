import type { Request, Response, NextFunction } from "express";
import {
  Webhook,
  WebhookVerificationError as StandardWebhookVerificationError,
} from "standardwebhooks";
import {
  validateEvent,
  WebhookVerificationError as PolarWebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app.error.js";
import { handleVerifiedEvent } from "./webhook.service.js";

/**
 * Verifies a Polar webhook payload using dual-scheme verification:
 * 1. Standard Webhooks specification (Base64-decoded 32-byte key - current Polar server format)
 * 2. Polar SDK legacy scheme (UTF-8 literal secret bytes - legacy Polar SDK format)
 */
export function verifyPolarWebhookPayload(
  body: Buffer,
  headers: Record<string, string>,
  secret: string,
): { type: string; data: unknown } {
  // Attempt 1: Standard Webhooks specification (32-byte key derived from whsec_...)
  try {
    const standardWebhook = new Webhook(secret);
    const parsed = standardWebhook.verify(body, headers) as {
      type: string;
      data: unknown;
    };
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed;
    }
  } catch (err: unknown) {
    if (!(err instanceof StandardWebhookVerificationError)) {
      throw err;
    }
  }

  // Attempt 2: Polar SDK validateEvent or literal secret key
  try {
    const validated = validateEvent(body, headers, secret) as {
      type: string;
      data: unknown;
    };
    return validated;
  } catch (sdkError: unknown) {
    // If validateEvent failed due to SDK schema parsing or signature mismatch,
    // verify with standardwebhooks directly using literal base64-encoded secret
    try {
      const base64Secret = Buffer.from(secret, "utf-8").toString("base64");
      const legacyWebhook = new Webhook(base64Secret);
      const parsedLegacy = legacyWebhook.verify(body, headers) as {
        type: string;
        data: unknown;
      };
      if (
        parsedLegacy &&
        typeof parsedLegacy === "object" &&
        typeof parsedLegacy.type === "string"
      ) {
        return parsedLegacy;
      }
    } catch {
      // Ignore fallback verification error
    }

    if (
      sdkError instanceof PolarWebhookVerificationError ||
      sdkError instanceof StandardWebhookVerificationError
    ) {
      throw new StandardWebhookVerificationError("No matching signature found");
    }

    throw sdkError;
  }
}

/**
 * Handles inbound Polar webhook events.
 *
 * SECURITY:
 * - This route must be mounted BEFORE global express.json().
 * - express.raw({ type: "application/json" }) must be applied to this route.
 * - No JWT authentication is required.
 * - Polar's cryptographic signature is the security boundary.
 * - The raw request body is verified before business logic runs.
 * - The webhook secret and raw body are never logged.
 */
export const polarWebhookHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // -------------------------------------------------------------------------
  // Step 1: Validate required Polar webhook headers
  // -------------------------------------------------------------------------
  const webhookId = req.headers["webhook-id"];
  const webhookTimestamp = req.headers["webhook-timestamp"];
  const webhookSignature = req.headers["webhook-signature"];

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

  // -------------------------------------------------------------------------
  // Step 2: Validate raw request body
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Step 3: Build the exact Standard Webhooks headers
  // -------------------------------------------------------------------------
  const webhookHeaders: Record<string, string> = {
    "webhook-id": webhookId,
    "webhook-timestamp": webhookTimestamp,
    "webhook-signature": webhookSignature,
  };

  // -------------------------------------------------------------------------
  // Step 4: Verify the webhook using dual-scheme verification
  // -------------------------------------------------------------------------
  let verifiedEvent: {
    type: string;
    data: unknown;
  };

  try {
    verifiedEvent = verifyPolarWebhookPayload(
      req.body,
      webhookHeaders,
      env.POLAR_WEBHOOK_SECRET,
    );
  } catch (error: unknown) {
    if (
      error instanceof StandardWebhookVerificationError ||
      error instanceof PolarWebhookVerificationError
    ) {
      console.error("[POLAR WEBHOOK VERIFICATION ERROR]", {
        message: error.message,
        webhookId,
        webhookTimestamp,
        bodyLength: req.body.length,
      });

      next(
        new AppError(
          "Webhook signature verification failed",
          403,
          "WEBHOOK_SIGNATURE_INVALID",
        ),
      );
      return;
    }

    console.error("[POLAR WEBHOOK UNKNOWN ERROR]", error);

    next(error);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 5: Signature verified successfully
  // -------------------------------------------------------------------------
  console.log("[POLAR WEBHOOK VERIFIED]", {
    webhookId,
    eventType: verifiedEvent.type,
  });

  // -------------------------------------------------------------------------
  // Step 6: Process verified webhook event
  // -------------------------------------------------------------------------
  handleVerifiedEvent(webhookId, verifiedEvent)
    .then(() => {
      res.status(202).send();
    })
    .catch((error: unknown) => {
      next(error);
    });
};