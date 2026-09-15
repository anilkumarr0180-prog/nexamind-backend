import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import { env } from "../config/env.js";

export type AccessTokenPayload = {
  sub: string;
  roles: string[];
};

export const generateAccessToken = (
  payload: AccessTokenPayload,
): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as StringValue,
  });
};

export const verifyAccessToken = (
  token: string,
): AccessTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_SECRET);

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof decoded.sub !== "string" ||
    !Array.isArray(decoded.roles) ||
    !decoded.roles.every(
      (role): role is string => typeof role === "string",
    )
  ) {
    throw new Error("Invalid access token payload");
  }

  return {
    sub: decoded.sub,
    roles: decoded.roles,
  };
};