import {
  WebhookEvent,
  type IWebhookEvent,
  type WebhookEventProvider,
} from "./webhook-event.model.js";

export type CreateWebhookEventData = {
  provider: WebhookEventProvider;
  eventId: string;
  eventType: string;
  receivedAt: Date;
};

/**
 * Finds an existing webhook event record by provider + eventId.
 * Used for idempotency checks before processing.
 */
export const findWebhookEvent = async (
  provider: WebhookEventProvider,
  eventId: string,
): Promise<IWebhookEvent | null> => {
  return WebhookEvent.findOne({ provider, eventId }).lean<IWebhookEvent | null>();
};

/**
 * Creates a new PENDING webhook event record.
 * Throws on duplicate (unique index violation) — caller should
 * interpret a duplicate key error as "already being processed".
 */
export const createWebhookEvent = async (
  data: CreateWebhookEventData,
): Promise<IWebhookEvent> => {
  const doc = new WebhookEvent({
    ...data,
    status: "PENDING",
    processedAt: null,
    failureReason: null,
  });
  await doc.save();
  return doc.toObject() as IWebhookEvent;
};

/**
 * Marks a webhook event as PROCESSED with the current timestamp.
 */
export const markWebhookEventProcessed = async (
  id: string,
): Promise<void> => {
  await WebhookEvent.findByIdAndUpdate(id, {
    $set: {
      status: "PROCESSED",
      processedAt: new Date(),
    },
  });
};

/**
 * Marks a webhook event as FAILED with a reason string.
 * The reason is trimmed to 2000 chars to stay within schema limits.
 */
export const markWebhookEventFailed = async (
  id: string,
  reason: string,
): Promise<void> => {
  await WebhookEvent.findByIdAndUpdate(id, {
    $set: {
      status: "FAILED",
      processedAt: new Date(),
      failureReason: reason.slice(0, 2000),
    },
  });
};

/**
 * Marks a webhook event as SKIPPED (e.g. unsupported event type).
 */
export const markWebhookEventSkipped = async (
  id: string,
): Promise<void> => {
  await WebhookEvent.findByIdAndUpdate(id, {
    $set: {
      status: "SKIPPED",
      processedAt: new Date(),
    },
  });
};
