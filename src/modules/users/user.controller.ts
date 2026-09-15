import type { Request, Response } from "express";
import * as userService from "./user.service.js";

export const getUserById = async (
  req: Request<{ userId: string }>,
  res: Response,
): Promise<void> => {
  const { userId } = req.params;

  const user = await userService.getUserById(userId);

  res.status(200).json({
    success: true,
    data: user,
  });
};