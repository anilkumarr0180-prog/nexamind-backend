import { Schema, model } from "mongoose";
import {
  ISubscription,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_STATUSES,
} from "./subscription.types.js";

const subscriptionSchema = new Schema<ISubscription>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
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
  },
  {
    timestamps: true,
  }
);

export const Subscription = model<ISubscription>(
  "Subscription",
  subscriptionSchema
);