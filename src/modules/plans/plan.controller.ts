import type { Request, Response } from "express";
import * as planService from "./plan.service.js";

export const getPlans = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  const plans = await planService.getActivePlans();

  res.status(200).json({
    success: true,
    data: plans,
  });
};

export const getPlanByCode = async (
  req: Request<{ code: string }>,
  res: Response,
): Promise<void> => {
  const { code } = req.params;

  const plan = await planService.getPlanByCode(code);

  res.status(200).json({
    success: true,
    data: plan,
  });
};