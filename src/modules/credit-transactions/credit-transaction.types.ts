import type { Types } from "mongoose";

export const CREDIT_TRANSACTION_TYPES = [
  "PLAN_GRANT",
  "USAGE",
  "REFUND",
  "BONUS",
  "ADMIN_ADJUSTMENT",
  "EXPIRATION",
] as const;

export type CreditTransactionType =
  (typeof CREDIT_TRANSACTION_TYPES)[number];

export interface ICreditTransaction {
  _id: Types.ObjectId;

  userId: Types.ObjectId;

  type: CreditTransactionType;

  amount: number;

  balanceBefore: number;
  balanceAfter: number;

  referenceId?: string | null;
  description?: string | null;

  createdAt: Date;
}