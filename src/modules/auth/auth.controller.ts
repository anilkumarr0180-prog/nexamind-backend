import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import * as authService from "./auth.service.js";
import type { LoginInput, RegisterInput } from "./auth.validation.js";

export const register = async (
  req: Request<Record<string, never>, unknown, RegisterInput>,
  res: Response,
): Promise<void> => {
  const result = await authService.register(req.body);

  res.status(201).json({
    success: true,
    data: result,
  });
};

export const login = async (
  req: Request<Record<string, never>, unknown, LoginInput>,
  res: Response,
): Promise<void> => {
  const result = await authService.login(req.body);

  res.status(200).json({
    success: true,
    data: result,
  });
};

export const getMe = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const user = await authService.getCurrentUser(authUser.userId);

  res.status(200).json({
    success: true,
    data: user,
  });
};
