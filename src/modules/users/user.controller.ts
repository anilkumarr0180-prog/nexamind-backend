import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as userService from "./user.service.js";

export const getUserById = async (
  req: Request<{ userId: string }>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;
  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const { userId } = req.params;

  const user = await userService.getUserById(userId, authUser);

  res.status(200).json({
    success: true,
    data: user,
  });
};