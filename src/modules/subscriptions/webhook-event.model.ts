import { Schema, model, type Types } from "mongoose";

export const WEBHOOK_EVENT_STATUSES = [
  "PENDING",
  "PROCESSED",
  "FAILED",
  "SKIPPED",
] as const;

export type WebhookEventStatus =
  (typeof WEBHOOK_EVENT_STATUSES)[number];

export const WEBHOOK_EVENT_PROVIDERS = ["POLAR"] as const;

export type WebhookEventProvider =
  (typeof WEBHOOK_EVENT_PROVIDERS)[number];

export interface IWebhookEvent {
  _id: Types.ObjectId;
  provider: WebhookEventProvider;
  /** The Standard Webhooks `webhook-id` header — unique per delivery attempt */
  eventId: string;
  eventType: string;
  status: WebhookEventStatus;
  receivedAt: Date;
  processedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    provider: {
      type: String,
      enum: WEBHOOK_EVENT_PROVIDERS,
      required: true,
    },

    eventId: {
      type: String,
      required: true,
      trim: true,
    },

    eventType: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: WEBHOOK_EVENT_STATUSES,
      required: true,
      default: "PENDING",
    },

    receivedAt: {
      type: Date,
      required: true,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Guarantees that the same Polar webhook-id can only be recorded once
 * per provider. Prevents duplicate processing across application restarts.
 */
webhookEventSchema.index(
  { provider: 1, eventId: 1 },
  { unique: true },
);

webhookEventSchema.index({ status: 1, createdAt: -1 });

export const WebhookEvent = model<IWebhookEvent>(
  "WebhookEvent",
  webhookEventSchema,
);
