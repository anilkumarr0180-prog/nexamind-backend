import type { RequestHandler } from "express";
import { AppError } from "../errors/app.error.js";
import { verifyAccessToken } from "../utils/jwt.js";

export const authenticate: RequestHandler = (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next(
      new AppError(
        "Authentication token is required",
        401,
        "UNAUTHORIZED",
      ),
    );
  }

  if (!authHeader.startsWith("Bearer ")) {
    return next(
      new AppError(
        "Authorization header must follow the Bearer format",
        401,
        "UNAUTHORIZED",
      ),
    );
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return next(
      new AppError(
        "Authentication token is required",
        401,
        "UNAUTHORIZED",
      ),
    );
  }

  try {
    const payload = verifyAccessToken(token);

    req.user = {
      userId: payload.sub,
      roles: payload.roles,
    };

    return next();
  } catch {
    return next(
      new AppError(
        "Invalid or expired authentication token",
        401,
        "UNAUTHORIZED",
      ),
    );
  }
};
