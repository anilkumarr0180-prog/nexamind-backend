import type { ClientSession, Types } from "mongoose";
import { TokenBalance, type ITokenBalance } from "./token.model.js";

export type CreateTokenBalanceData = {
  userId: string | Types.ObjectId;
  balance: number;
};

export const findTokenBalanceByUserId = async (
  userId: string | Types.ObjectId,
  session?: ClientSession,
): Promise<ITokenBalance | null> => {
  return TokenBalance.findOne({ userId })
    .session(session ?? null)
    .exec();
};

export const createTokenBalance = async (
  data: CreateTokenBalanceData,
): Promise<ITokenBalance> => {
  return TokenBalance.create(data);
};

export const atomicDeductBalance = async (
  userId: string | Types.ObjectId,
  amount: number,
): Promise<ITokenBalance | null> => {
  return TokenBalance.findOneAndUpdate(
    {
      userId,
      balance: { $gte: amount },
    },
    {
      $inc: { balance: -amount },
    },
    {
      returnDocument: "after",
      runValidators: true,
    },
  ).exec();
};

export const atomicAddBalance = async (
  userId: string | Types.ObjectId,
  amount: number,
): Promise<ITokenBalance | null> => {
  return TokenBalance.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount },
    },
    {
      returnDocument: "after",
      runValidators: true,
    },
  ).exec();
};

export const atomicDeductBalanceWithSession = async (
  userId: string | Types.ObjectId,
  amount: number,
  session: ClientSession,
): Promise<ITokenBalance | null> => {
  return TokenBalance.findOneAndUpdate(
    {
      userId,
      balance: { $gte: amount },
    },
    {
      $inc: { balance: -amount },
    },
    {
      returnDocument: "after",
      runValidators: true,
      session,
    },
  ).exec();
};

export const atomicAddBalanceWithSession = async (
  userId: string | Types.ObjectId,
  amount: number,
  session: ClientSession,
): Promise<ITokenBalance | null> => {
  return TokenBalance.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount },
    },
    {
      returnDocument: "after",
      runValidators: true,
      session,
    },
  ).exec();
};