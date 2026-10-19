import type { Request, Response } from "express";
import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import * as authService from "./auth.service.js";
import type {
  GoogleAuthInput,
  LoginInput,
  LogoutInput,
  RefreshInput,
  RegisterInput,
  VscodeAuthorizeInput,
  VscodeExchangeInput,
} from "./auth.validation.js";

export const REFRESH_COOKIE_NAME = "nexamind_rt";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
export const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Parses a specific cookie value from the raw Cookie request header.
 */
export const getCookieValue = (
  req: Request,
  name: string,
): string | undefined => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return undefined;
  }

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawKey, ...valParts] = cookie.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(valParts.join("="));
    }
  }

  return undefined;
};

/**
 * Checks whether the incoming request originated from an explicitly configured CORS browser origin.
 */
export const isAllowedBrowserOrigin = (req: Request): boolean => {
  const originHeader = req.headers.origin;
  if (typeof originHeader === "string" && originHeader.length > 0) {
    const cleanOrigin = originHeader.trim().replace(/\/+$/, "");
    return env.CORS_ORIGINS.includes(cleanOrigin);
  }

  const refererHeader = req.headers.referer;
  if (typeof refererHeader === "string" && refererHeader.length > 0) {
    try {
      const url = new URL(refererHeader);
      return env.CORS_ORIGINS.includes(url.origin);
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * Sets the HttpOnly refresh token cookie on the response for verified browser clients.
 */
export const setRefreshTokenCookie = (
  res: Response,
  token: string,
): void => {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    secure: env.NODE_ENV === "production",
  });
};

/**
 * Clears the HttpOnly refresh token cookie with matching attributes.
 */
export const clearRefreshTokenCookie = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    secure: env.NODE_ENV === "production",
  });
};

export const register = async (
  req: Request<Record<string, never>, unknown, RegisterInput>,
  res: Response,
): Promise<void> => {
  const result = await authService.register(req.body);

  if (env.AUTH_RENEWAL_ENABLED && isAllowedBrowserOrigin(req)) {
    const rawRefreshToken = await authService.issueWebRefreshToken(result.user.id);
    setRefreshTokenCookie(res, rawRefreshToken);
  }

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

  if (env.AUTH_RENEWAL_ENABLED && isAllowedBrowserOrigin(req)) {
    const rawRefreshToken = await authService.issueWebRefreshToken(result.user.id);
    setRefreshTokenCookie(res, rawRefreshToken);
  }

  res.status(200).json({
    success: true,
    data: result,
  });
};

export const googleAuth = async (
  req: Request<Record<string, never>, unknown, GoogleAuthInput>,
  res: Response,
): Promise<void> => {
  const result = await authService.googleAuth(req.body);

  if (env.AUTH_RENEWAL_ENABLED && isAllowedBrowserOrigin(req)) {
    const rawRefreshToken = await authService.issueWebRefreshToken(result.user.id);
    setRefreshTokenCookie(res, rawRefreshToken);
  }

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

export const linkGoogle = async (
  req: Request<Record<string, never>, unknown, GoogleAuthInput>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const result = await authService.linkGoogleAccount(authUser.userId, req.body);

  res.status(200).json({
    success: true,
    data: result,
  });
};

export const vscodeAuthorize = async (
  req: Request<Record<string, never>, unknown, VscodeAuthorizeInput>,
  res: Response,
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const result = await authService.vscodeAuthorize(authUser.userId, req.body);

  res.status(200).json({
    success: true,
    data: result,
  });
};

export const vscodeExchange = async (
  req: Request<Record<string, never>, unknown, VscodeExchangeInput>,
  res: Response,
): Promise<void> => {
  const result = await authService.vscodeExchange(req.body);

  res.status(200).json({
    success: true,
    data: result,
  });
};

/**
 * Handles session token refresh across two explicit delivery modes:
 * - Browser: reads HttpOnly nexamind_rt cookie, validates origin, sets rotated cookie, returns { user, accessToken }.
 * - VS Code: reads body refreshToken, returns { user, accessToken, refreshToken }.
 */
export const refresh = async (
  req: Request<Record<string, never>, unknown, RefreshInput>,
  res: Response,
): Promise<void> => {
  const bodyToken = req.body?.refreshToken;

  if (bodyToken) {
    // Mode: VS Code extension
    const result = await authService.refreshSession({
      token: bodyToken,
      expectedClientType: "vscode",
    });

    res.status(200).json({
      success: true,
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    });
    return;
  }

  // Mode: Browser (cookie-based)
  const cookieToken = getCookieValue(req, REFRESH_COOKIE_NAME);
  if (!cookieToken) {
    throw new AppError("Refresh token is required", 401, "UNAUTHORIZED");
  }

  if (!isAllowedBrowserOrigin(req)) {
    throw new AppError(
      "Origin not allowed for browser session",
      403,
      "FORBIDDEN",
    );
  }

  const result = await authService.refreshSession({
    token: cookieToken,
    expectedClientType: "web",
  });

  // Set rotated refresh token in HttpOnly cookie
  setRefreshTokenCookie(res, result.refreshToken);

  // Return new access token and user in JSON, NEVER the refresh token
  res.status(200).json({
    success: true,
    data: {
      user: result.user,
      accessToken: result.accessToken,
    },
  });
};

/**
 * Revokes refresh-token families for browser and/or VS Code sessions and clears cookies.
 * Repeated calls are strictly idempotent and safe.
 */
export const logout = async (
  req: Request<Record<string, never>, unknown, LogoutInput>,
  res: Response,
): Promise<void> => {
  const bodyToken = req.body?.refreshToken;
  const cookieToken = getCookieValue(req, REFRESH_COOKIE_NAME);

  const originHeader = req.headers.origin || req.headers.referer;
  if (originHeader && cookieToken && !isAllowedBrowserOrigin(req)) {
    throw new AppError(
      "Origin not allowed for browser session",
      403,
      "FORBIDDEN",
    );
  }

  if (bodyToken) {
    await authService.revokeSession(bodyToken);
  }

  if (cookieToken) {
    await authService.revokeSession(cookieToken);
  }

  clearRefreshTokenCookie(res);

  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
};
