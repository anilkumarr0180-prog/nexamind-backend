import { Types } from "mongoose";
import { Subscription } from "./subscription.model.js";
import type {
  CreateSubscriptionData,
  ISubscription,
  SubscriptionStatus,
  UpdateSubscriptionData,
} from "./subscription.types.js";

export const CURRENT_STATUSES: readonly SubscriptionStatus[] = [
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "INCOMPLETE",
] as const;

export const createSubscription = async (
  data: CreateSubscriptionData,
): Promise<ISubscription> => {
  return Subscription.create(data);
};

export const findCurrentSubscriptionByUserId = async (
  userId: string,
): Promise<ISubscription | null> => {
  return Subscription.findOne({
    userId: new Types.ObjectId(userId),
    status: { $in: CURRENT_STATUSES },
  })
    .sort({ createdAt: -1 })
    .lean<ISubscription | null>();
};

export const findSubscriptionByProviderId = async (
  providerSubscriptionId: string,
): Promise<ISubscription | null> => {
  return Subscription.findOne({
    providerSubscriptionId,
  }).lean<ISubscription | null>();
};

export const findSubscriptionById = async (
  subscriptionId: string,
): Promise<ISubscription | null> => {
  return Subscription.findById(subscriptionId).lean<ISubscription | null>();
};

export const updateSubscriptionById = async (
  subscriptionId: string,
  data: UpdateSubscriptionData,
): Promise<ISubscription | null> => {
  return Subscription.findByIdAndUpdate(
    subscriptionId,
    { $set: data },
    {
      returnDocument: "after",
      runValidators: true,
    },
  ).lean<ISubscription | null>();
};

export const updateSubscriptionByProviderId = async (
  providerSubscriptionId: string,
  data: UpdateSubscriptionData,
): Promise<ISubscription | null> => {
  return Subscription.findOneAndUpdate(
    { providerSubscriptionId },
    { $set: data },
    {
      returnDocument: "after",
      runValidators: true,
    },
  ).lean<ISubscription | null>();
};