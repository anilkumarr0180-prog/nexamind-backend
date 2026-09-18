import { Types, type ClientSession } from "mongoose";
import { CreditTransaction } from "./credit-transaction.model.js";
import type {
  CreditTransactionType,
  ICreditTransaction,
} from "./credit-transaction.types.js";

export type CreateCreditTransactionData = {
  userId: Types.ObjectId;
  type: CreditTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceId?: string | null;
  description?: string | null;
};

export const createCreditTransaction = async (
  data: CreateCreditTransactionData,
  session?: ClientSession,
): Promise<ICreditTransaction> => {
  const transaction = new CreditTransaction(data);

  if (session) {
    await transaction.save({ session });
  } else {
    await transaction.save();
  }

  return transaction.toObject() as ICreditTransaction;
};

export const findCreditTransactionsByUserId = async (
  userId: string,
  limit = 50,
  skip = 0,
): Promise<ICreditTransaction[]> => {
  if (!Types.ObjectId.isValid(userId)) {
    return [];
  }

  return CreditTransaction.find({
    userId: new Types.ObjectId(userId),
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean<ICreditTransaction[]>();
};

export const findCreditTransactionsByType = async (
  userId: string,
  type: CreditTransactionType,
  limit = 50,
  skip = 0,
): Promise<ICreditTransaction[]> => {
  if (!Types.ObjectId.isValid(userId)) {
    return [];
  }

  return CreditTransaction.find({
    userId: new Types.ObjectId(userId),
    type,
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean<ICreditTransaction[]>();
};

export const findCreditTransactionByReferenceId = async (
  referenceId: string,
  type?: CreditTransactionType,
): Promise<ICreditTransaction | null> => {
  if (!referenceId.trim()) {
    return null;
  }

  const filter: {
    referenceId: string;
    type?: CreditTransactionType;
  } = {
    referenceId: referenceId.trim(),
  };

  if (type) {
    filter.type = type;
  }

  return CreditTransaction.findOne(filter)
    .lean<ICreditTransaction | null>();
};

export const findCreditTransactionByReferenceIdAndType =
  async (
    referenceId: string,
    type: CreditTransactionType,
  ): Promise<ICreditTransaction | null> => {
    if (!referenceId.trim()) {
      return null;
    }

    return CreditTransaction.findOne({
      referenceId: referenceId.trim(),
      type,
    }).lean<ICreditTransaction | null>();
  };