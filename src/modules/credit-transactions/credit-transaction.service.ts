import { Types } from "mongoose";
import { AppError } from "../../errors/app.error.js";
import * as creditTransactionRepository from "./credit-transaction.repository.js";
import type { CreditTransactionType } from "./credit-transaction.types.js";

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id);
};

const validateAmount = (amount: number): void => {
  if (
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount < 0
  ) {
    throw new AppError(
      "Transaction amount must be a non-negative integer",
      400,
      "INVALID_TRANSACTION_AMOUNT",
    );
  }
};

const validateBalance = (
  balance: number,
  fieldName: string,
): void => {
  if (
    !Number.isFinite(balance) ||
    !Number.isInteger(balance) ||
    balance < 0
  ) {
    throw new AppError(
      `${fieldName} must be a non-negative integer`,
      400,
      "INVALID_TRANSACTION_BALANCE",
    );
  }
};

export type CreateCreditTransactionInput = {
  userId: string;
  type: CreditTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceId?: string | null;
  description?: string | null;
};

export const recordCreditTransaction = async (
  input: CreateCreditTransactionInput,
) => {
  if (!isValidObjectId(input.userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  validateAmount(input.amount);
  validateBalance(input.balanceBefore, "Balance before");
  validateBalance(input.balanceAfter, "Balance after");

  if (
    input.referenceId !== undefined &&
    input.referenceId !== null &&
    !input.referenceId.trim()
  ) {
    throw new AppError(
      "Reference ID cannot be empty",
      400,
      "INVALID_REFERENCE_ID",
    );
  }

  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > 500
  ) {
    throw new AppError(
      "Description cannot exceed 500 characters",
      400,
      "INVALID_DESCRIPTION",
    );
  }

  return creditTransactionRepository.createCreditTransaction({
    userId: new Types.ObjectId(input.userId),
    type: input.type,
    amount: input.amount,
    balanceBefore: input.balanceBefore,
    balanceAfter: input.balanceAfter,
    referenceId: input.referenceId ?? null,
    description: input.description ?? null,
  });
};

export const getUserCreditTransactions = async (
  userId: string,
  limit = 50,
  skip = 0,
) => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > 100
  ) {
    throw new AppError(
      "Limit must be between 1 and 100",
      400,
      "INVALID_LIMIT",
    );
  }

  if (!Number.isInteger(skip) || skip < 0) {
    throw new AppError(
      "Skip must be a non-negative integer",
      400,
      "INVALID_SKIP",
    );
  }

  return creditTransactionRepository.findCreditTransactionsByUserId(
    userId,
    limit,
    skip,
  );
};

export const getUserCreditTransactionsByType = async (
  userId: string,
  type: CreditTransactionType,
  limit = 50,
  skip = 0,
) => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > 100
  ) {
    throw new AppError(
      "Limit must be between 1 and 100",
      400,
      "INVALID_LIMIT",
    );
  }

  if (!Number.isInteger(skip) || skip < 0) {
    throw new AppError(
      "Skip must be a non-negative integer",
      400,
      "INVALID_SKIP",
    );
  }

  return creditTransactionRepository.findCreditTransactionsByType(
    userId,
    type,
    limit,
    skip,
  );
};

export const findTransactionByReferenceId = async (
  referenceId: string,
  type?: CreditTransactionType,
) => {
  if (!referenceId.trim()) {
    throw new AppError(
      "Reference ID is required",
      400,
      "INVALID_REFERENCE_ID",
    );
  }

  return creditTransactionRepository.findCreditTransactionByReferenceId(
    referenceId,
    type,
  );
};

export const findTransactionByReferenceIdAndType = async (
  referenceId: string,
  type: CreditTransactionType,
) => {
  if (!referenceId.trim()) {
    throw new AppError(
      "Reference ID is required",
      400,
      "INVALID_REFERENCE_ID",
    );
  }

  return creditTransactionRepository.findCreditTransactionByReferenceIdAndType(
    referenceId,
    type,
  );
};