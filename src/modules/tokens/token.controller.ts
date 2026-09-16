import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as tokenService from "./token.service.js";

export const getBalance = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  const userId = authUser?.sub ?? authUser?.userId;

  if (!userId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const balanceData = await tokenService.getBalance(userId);

  res.status(200).json({
    success: true,
    data: {
      balance: balanceData.balance,
      updatedAt: balanceData.updatedAt,
    },
  });
};
