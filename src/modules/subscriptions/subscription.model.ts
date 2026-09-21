import { Schema, model } from "mongoose";
import {
  type ISubscription,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_INTERVALS,
} from "./subscription.types.js";

const subscriptionSchema = new Schema<ISubscription>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    planId: {
      type: Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: SUBSCRIPTION_PROVIDERS,
      required: true,
    },

    providerSubscriptionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    providerCustomerId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    providerProductId: {
      type: String,
      required: true,
      trim: true,
    },

    interval: {
      type: String,
      enum: SUBSCRIPTION_INTERVALS,
      required: true,
    },

    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      required: true,
      index: true,
    },

    currentPeriodStart: {
      type: Date,
      required: true,
    },

    currentPeriodEnd: {
      type: Date,
      required: true,
    },

    cancelAtPeriodEnd: {
      type: Boolean,
      required: true,
      default: false,
    },

    canceledAt: {
      type: Date,
      default: null,
    },

    endedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

subscriptionSchema.index({ userId: 1, status: 1 });

export const Subscription = model<ISubscription>(
  "Subscription",
  subscriptionSchema,
);