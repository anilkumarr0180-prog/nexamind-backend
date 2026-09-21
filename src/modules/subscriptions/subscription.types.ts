import type { Types } from "mongoose";

export const SUBSCRIPTION_STATUSES = [
  "INCOMPLETE",
  "INCOMPLETE_EXPIRED",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "UNPAID",
  "REVOKED",
] as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_PROVIDERS = ["POLAR"] as const;

export type SubscriptionProvider =
  (typeof SUBSCRIPTION_PROVIDERS)[number];

export const SUBSCRIPTION_INTERVALS = ["MONTHLY", "YEARLY"] as const;

export type SubscriptionInterval =
  (typeof SUBSCRIPTION_INTERVALS)[number];

export interface ISubscription {
  _id: Types.ObjectId;

  userId: Types.ObjectId;
  planId: Types.ObjectId;

  provider: SubscriptionProvider;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerProductId: string;

  interval: SubscriptionInterval;
  status: SubscriptionStatus;

  currentPeriodStart: Date;
  currentPeriodEnd: Date;

  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type CreateSubscriptionData = {
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  provider: SubscriptionProvider;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerProductId: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | null;
  endedAt?: Date | null;
};

export type UpdateSubscriptionData = {
  planId?: Types.ObjectId;
  providerProductId?: string;
  interval?: SubscriptionInterval;
  status?: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | null;
  endedAt?: Date | null;
};