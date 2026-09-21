import type { Types } from "mongoose";

export const SUBSCRIPTION_STATUSES = [
  "ACTIVE",
  "CANCELED",
  "PAST_DUE",
  "REVOKED",
  "INCOMPLETE",
] as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_PROVIDERS = ["POLAR"] as const;

export type SubscriptionProvider =
  (typeof SUBSCRIPTION_PROVIDERS)[number];

export interface ISubscription {
  _id: Types.ObjectId;

  userId: Types.ObjectId;
  planId: Types.ObjectId;

  provider: SubscriptionProvider;
  providerSubscriptionId: string;

  status: SubscriptionStatus;

  currentPeriodStart: Date;
  currentPeriodEnd: Date;

  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}