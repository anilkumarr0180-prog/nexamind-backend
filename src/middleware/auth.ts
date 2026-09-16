import type { RequestHandler } from "express";
import { AppError } from "../errors/app.error.js";
import { verifyAccessToken, type AccessTokenPayload } from "../utils/jwt.js";
import { findUserById } from "../modules/users/user.repository.js";
import { USER_STATUSES } from "../modules/users/user.model.js";

export const authenticate: RequestHandler = async (req, _res, next) => {
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

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(
      new AppError(
        "Invalid or expired authentication token",
        401,
        "UNAUTHORIZED",
      ),
    );
  }

  try {
    const user = await findUserById(payload.sub);

    if (!user) {
      return next(
        new AppError(
          "User not found",
          401,
          "UNAUTHORIZED",
        ),
      );
    }

    if (user.status === USER_STATUSES.SUSPENDED) {
      return next(
        new AppError(
          "Account is suspended",
          403,
          "ACCOUNT_SUSPENDED",
        ),
      );
    }

    if (user.status === USER_STATUSES.DISABLED) {
      return next(
        new AppError(
          "Account is disabled",
          403,
          "ACCOUNT_DISABLED",
        ),
      );
    }

    if (user.status !== USER_STATUSES.ACTIVE) {
      return next(
        new AppError(
          "Account is not active",
          403,
          "ACCOUNT_NOT_ACTIVE",
        ),
      );
    }

    req.user = {
      userId: user._id.toString(),
      sub: user._id.toString(),
      roles: [...user.roles],
    };

    return next();
  } catch (error: unknown) {
    if (error instanceof AppError) {
      return next(error);
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: string }).name === "CastError"
    ) {
      return next(
        new AppError(
          "Invalid or expired authentication token",
          401,
          "UNAUTHORIZED",
        ),
      );
    }

    return next(error);
  }
};
