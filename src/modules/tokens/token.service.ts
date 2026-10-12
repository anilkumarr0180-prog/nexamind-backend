import mongoose, { Types } from "mongoose";
import { AppError } from "../../errors/app.error.js";
import * as tokenRepository from "./token.repository.js";
import * as userRepository from "../users/user.repository.js";
import * as creditTransactionRepository from "../credit-transactions/credit-transaction.repository.js";
import { PLAN_CODES, PLAN_CREDITS } from "../plans/plan.model.js";
import * as planRepository from "../plans/plan.repository.js";

export const DEFAULT_INITIAL_BALANCE = PLAN_CREDITS[PLAN_CODES.FREE];

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

export type TokenBalanceResult = {
  balance: number;
  updatedAt: Date;
};

const isValidObjectId = (id: string): boolean => {
  return OBJECT_ID_REGEX.test(id);
};

export const initializeBalance = async (
  userId: string,
  initialBalance?: number,
): Promise<TokenBalanceResult> => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  // Check if balance already exists. Never overwrite an existing balance!
  const existing =
    await tokenRepository.findTokenBalanceByUserId(userId);

  if (existing) {
    return {
      balance: existing.balance,
      updatedAt: existing.updatedAt,
    };
  }

  // Resolve initial credits through canonical Plan definition if not explicitly provided
  const targetBalance =
    initialBalance !== undefined
      ? initialBalance
      : await planRepository.getPlanCreditsByCode(PLAN_CODES.FREE);

  if (
    typeof targetBalance !== "number" ||
    !Number.isFinite(targetBalance) ||
    !Number.isInteger(targetBalance) ||
    targetBalance < 0
  ) {
    throw new AppError(
      "Initial balance must be a non-negative integer",
      400,
      "INVALID_CREDIT_AMOUNT",
    );
  }

  const session = await mongoose.startSession();

  try {
    let result: TokenBalanceResult | null = null;

    await session.withTransaction(async () => {
      const current =
        await tokenRepository.findTokenBalanceByUserId(userId, session);

      if (current) {
        result = {
          balance: current.balance,
          updatedAt: current.updatedAt,
        };
        return;
      }

      const created = await tokenRepository.createTokenBalance(
        {
          userId,
          balance: targetBalance,
        },
        session,
      );

      // Record immutable audit ledger entry for the initial grant
      await creditTransactionRepository.createCreditTransaction(
        {
          userId: new Types.ObjectId(userId),
          type: "PLAN_GRANT",
          amount: targetBalance,
          balanceBefore: 0,
          balanceAfter: targetBalance,
          referenceId: `free_grant_${userId}`,
          description: "Initial free plan credit grant",
        },
        session,
      );

      result = {
        balance: created.balance,
        updatedAt: created.updatedAt,
      };
    });

    if (result) {
      return result;
    }

    const concurrentBalance =
      await tokenRepository.findTokenBalanceByUserId(userId);

    if (concurrentBalance) {
      return {
        balance: concurrentBalance.balance,
        updatedAt: concurrentBalance.updatedAt,
      };
    }

    throw new AppError(
      "Failed to initialize token balance",
      500,
      "TOKEN_INITIALIZATION_FAILED",
    );
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      const concurrentBalance =
        await tokenRepository.findTokenBalanceByUserId(userId);

      if (concurrentBalance) {
        return {
          balance: concurrentBalance.balance,
          updatedAt: concurrentBalance.updatedAt,
        };
      }
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "Failed to initialize token balance",
      500,
      "TOKEN_INITIALIZATION_FAILED",
    );
  } finally {
    await session.endSession();
  }
};

export const getBalance = async (
  userId: string,
): Promise<TokenBalanceResult> => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new AppError(
      "User not found",
      404,
      "USER_NOT_FOUND",
    );
  }

  const tokenBalance =
    await tokenRepository.findTokenBalanceByUserId(userId);

  if (!tokenBalance) {
    return initializeBalance(userId);
  }

  return {
    balance: tokenBalance.balance,
    updatedAt: tokenBalance.updatedAt,
  };
};

export const deductCredits = async (
  userId: string,
  amount: number,
  referenceId?: string | null,
): Promise<TokenBalanceResult> => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    throw new AppError(
      "Credit amount must be a positive integer",
      400,
      "INVALID_CREDIT_AMOUNT",
    );
  }

  const cleanReferenceId = referenceId?.trim() || null;

  // Idempotency pre-check: if referenceId provided, check if already recorded
  if (cleanReferenceId) {
    const existingTx =
      await creditTransactionRepository.findCreditTransactionByReferenceIdAndType(
        cleanReferenceId,
        "USAGE",
      );

    if (existingTx && existingTx.userId.toString() === userId) {
      return {
        balance: existingTx.balanceAfter,
        updatedAt: existingTx.createdAt,
      };
    }
  }

  const session = await mongoose.startSession();

  try {
    let result: TokenBalanceResult | null = null;

    await session.withTransaction(async () => {
      // Hot path optimization: Execute conditional atomic update directly without preliminary read
      const updated =
        await tokenRepository.atomicDeductBalanceWithSession(
          new Types.ObjectId(userId),
          amount,
          session,
        );

      if (!updated) {
        // Distinguish between insufficient balance (402) and user balance not found (404)
        const currentBalance =
          await tokenRepository.findTokenBalanceByUserId(
            userId,
            session,
          );

        if (!currentBalance) {
          throw new AppError(
            "Token balance not found for user",
            404,
            "TOKEN_BALANCE_NOT_FOUND",
          );
        }

        throw new AppError(
          "Insufficient credit balance",
          402,
          "INSUFFICIENT_CREDITS",
        );
      }

      const balanceAfter = updated.balance;
      const balanceBefore = balanceAfter + amount;

      await creditTransactionRepository.createCreditTransaction(
        {
          userId: new Types.ObjectId(userId),
          type: "USAGE",
          amount,
          balanceBefore,
          balanceAfter,
          referenceId: cleanReferenceId,
          description: "AI usage",
        },
        session,
      );

      result = {
        balance: balanceAfter,
        updatedAt: updated.updatedAt,
      };
    });

    if (!result) {
      throw new AppError(
        "Failed to process credit deduction",
        500,
        "CREDIT_DEDUCTION_FAILED",
      );
    }

    return result;
  } catch (error: unknown) {
    // Under concurrent race conditions with identical referenceId, unique partial index throws code 11000.
    // Verify that the transaction was indeed completed by the concurrent winning request.
    if (
      cleanReferenceId &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      const existingTx =
        await creditTransactionRepository.findCreditTransactionByReferenceIdAndType(
          cleanReferenceId,
          "USAGE",
        );

      if (existingTx && existingTx.userId.toString() === userId) {
        return {
          balance: existingTx.balanceAfter,
          updatedAt: existingTx.createdAt,
        };
      }
    }

    throw error;
  } finally {
    await session.endSession();
  }
};

export const refundCredits = async (
  userId: string,
  amount: number,
  referenceId?: string | null,
): Promise<TokenBalanceResult> => {
  if (!isValidObjectId(userId)) {
    throw new AppError(
      "Invalid user ID",
      400,
      "INVALID_USER_ID",
    );
  }

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    throw new AppError(
      "Credit amount must be a positive integer",
      400,
      "INVALID_CREDIT_AMOUNT",
    );
  }

  const cleanReferenceId = referenceId?.trim() || null;

  // Idempotency pre-check: if referenceId provided, check if already recorded
  if (cleanReferenceId) {
    const existingTx =
      await creditTransactionRepository.findCreditTransactionByReferenceIdAndType(
        cleanReferenceId,
        "REFUND",
      );

    if (existingTx && existingTx.userId.toString() === userId) {
      return {
        balance: existingTx.balanceAfter,
        updatedAt: existingTx.createdAt,
      };
    }
  }

  const session = await mongoose.startSession();

  try {
    let result: TokenBalanceResult | null = null;

    await session.withTransaction(async () => {
      // Hot path optimization: Execute conditional atomic update directly without preliminary read
      const updated =
        await tokenRepository.atomicAddBalanceWithSession(
          new Types.ObjectId(userId),
          amount,
          session,
        );

      if (!updated) {
        throw new AppError(
          "Token balance not found for user",
          404,
          "TOKEN_BALANCE_NOT_FOUND",
        );
      }

      const balanceAfter = updated.balance;
      const balanceBefore = balanceAfter - amount;

      await creditTransactionRepository.createCreditTransaction(
        {
          userId: new Types.ObjectId(userId),
          type: "REFUND",
          amount,
          balanceBefore,
          balanceAfter,
          referenceId: cleanReferenceId,
          description: "Credit refund",
        },
        session,
      );

      result = {
        balance: balanceAfter,
        updatedAt: updated.updatedAt,
      };
    });

    if (!result) {
      throw new AppError(
        "Failed to process credit refund",
        500,
        "CREDIT_REFUND_FAILED",
      );
    }

    return result;
  } catch (error: unknown) {
    // Under concurrent race conditions with identical referenceId, unique partial index throws code 11000.
    // Verify that the refund transaction was indeed completed by the concurrent winning request.
    if (
      cleanReferenceId &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      const existingTx =
        await creditTransactionRepository.findCreditTransactionByReferenceIdAndType(
          cleanReferenceId,
          "REFUND",
        );

      if (existingTx && existingTx.userId.toString() === userId) {
        return {
          balance: existingTx.balanceAfter,
          updatedAt: existingTx.createdAt,
        };
      }
    }

    throw error;
  } finally {
    await session.endSession();
  }
};