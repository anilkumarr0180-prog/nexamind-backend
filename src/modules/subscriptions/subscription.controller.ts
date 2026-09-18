import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as subscriptionService from "./subscription.service.js";

export const getMySubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError(
      "Authentication required",
      401,
      "UNAUTHORIZED",
    );
  }

  const subscription =
    await subscriptionService.getCurrentSubscription(
      authUser.userId,
    );

  res.status(200).json({
    success: true,
    data: {
      subscription,
    },
  });
};