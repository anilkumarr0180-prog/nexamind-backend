import { Types } from "mongoose";
import { Subscription } from "./subscription.model.js";
import type { ISubscription } from "./subscription.types.js";

const CURRENT_STATUSES = [
  "ACTIVE",
  "PAST_DUE",
  "INCOMPLETE",
] as const;

export const createSubscription = async (
  data: Partial<ISubscription>,
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
  data: Partial<ISubscription>,
): Promise<ISubscription | null> => {
  return Subscription.findByIdAndUpdate(
    subscriptionId,
    { $set: data },
    {
      new: true,
      runValidators: true,
    },
  ).lean<ISubscription | null>();
};