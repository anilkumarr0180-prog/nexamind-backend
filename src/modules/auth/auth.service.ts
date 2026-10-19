import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";
import { USER_STATUSES } from "../users/user.model.js";
import * as userRepository from "../users/user.repository.js";
import * as tokenService from "../tokens/token.service.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { generateAccessToken } from "../../utils/jwt.js";
import { RefreshToken } from "./refresh-token.model.js";
import { RefreshTokenRotationCache } from "./refresh-token-rotation-cache.model.js";
import { AuthorizationCode } from "./authorization-code.model.js";
import {
  generateRefreshToken,
  hashToken,
  validateRotationKey,
  encryptRotationResult,
  decryptRotationResult,
  isRotationCacheExpired,
} from "./refresh-token.util.js";
import type {
  GoogleAuthInput,
  LoginInput,
  RegisterInput,
  VscodeAuthorizeInput,
  VscodeExchangeInput,
} from "./auth.validation.js";
import { verifyGoogleIdToken } from "./google.verifier.js";

export type SafeUser = {
  id: string;
  name?: string | null;
  email: string;
  status: string;
  roles: string[];
  isGoogleLinked?: boolean;
  googleLinked?: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthResult = {
  user: SafeUser;
  accessToken: string;
};

export const toSafeUser = (user: {
  _id: { toString(): string };
  name?: string | null;
  email: string;
  status: string;
  roles: string[];
  googleId?: string | null;
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): SafeUser => ({
  id: user._id.toString(),
  name: user.name ?? null,
  email: user.email,
  status: user.status,
  roles: [...user.roles],
  isGoogleLinked: Boolean(user.googleId),
  googleLinked: Boolean(user.googleId),
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt ?? new Date(),
  updatedAt: user.updatedAt ?? new Date(),
});

export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedName = input.name ? input.name.trim() : null;

  const existingUser = await userRepository.findUserByEmail(normalizedEmail);
  if (existingUser) {
    throw new AppError(
      "User with this email already exists",
      409,
      "USER_ALREADY_EXISTS",
    );
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await userRepository.createUser({
      name: normalizedName,
      email: normalizedEmail,
      passwordHash,
    });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      throw new AppError(
        "User with this email already exists",
        409,
        "USER_ALREADY_EXISTS",
      );
    }

    throw error;
  }

  await tokenService.initializeBalance(user._id.toString());

  const accessToken = generateAccessToken({
    sub: user._id.toString(),
    roles: user.roles,
  });

  return {
    user: toSafeUser(user),
    accessToken,
  };
};

export const login = async (input: LoginInput): Promise<AuthResult> => {
  const normalizedEmail = input.email.trim().toLowerCase();

  const user = await userRepository.findUserByEmail(normalizedEmail, true);

  if (!user || !user.passwordHash) {
    throw new AppError(
      "Invalid email or password",
      401,
      "INVALID_CREDENTIALS",
    );
  }

  const isPasswordValid = await verifyPassword(
    input.password,
    user.passwordHash,
  );

  if (!isPasswordValid) {
    throw new AppError(
      "Invalid email or password",
      401,
      "INVALID_CREDENTIALS",
    );
  }

  if (user.status === USER_STATUSES.SUSPENDED) {
    throw new AppError(
      "Account is suspended",
      403,
      "ACCOUNT_SUSPENDED",
    );
  }

  if (user.status === USER_STATUSES.DISABLED) {
    throw new AppError(
      "Account is disabled",
      403,
      "ACCOUNT_DISABLED",
    );
  }

  if (user.status !== USER_STATUSES.ACTIVE) {
    throw new AppError(
      "Account is not active",
      403,
      "ACCOUNT_NOT_ACTIVE",
    );
  }

  const updatedUser = await userRepository.updateLastLoginAt(
    user._id.toString(),
  );

  const activeUser = updatedUser ?? user;

  const accessToken = generateAccessToken({
    sub: activeUser._id.toString(),
    roles: activeUser.roles,
  });

  return {
    user: toSafeUser(activeUser),
    accessToken,
  };
};

export const getCurrentUser = async (userId: string): Promise<SafeUser> => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new AppError(
      "User not found",
      404,
      "USER_NOT_FOUND",
    );
  }

  if (user.status === USER_STATUSES.SUSPENDED) {
    throw new AppError(
      "Account is suspended",
      403,
      "ACCOUNT_SUSPENDED",
    );
  }

  if (user.status === USER_STATUSES.DISABLED) {
    throw new AppError(
      "Account is disabled",
      403,
      "ACCOUNT_DISABLED",
    );
  }

  return toSafeUser(user);
};

export const googleAuth = async (
  input: GoogleAuthInput,
): Promise<AuthResult> => {
  const payload = await verifyGoogleIdToken(input.credential);

  // 1. Primary identity lookup by Google's unique `sub`
  const existingGoogleUser = await userRepository.findUserByGoogleId(
    payload.sub,
  );

  if (existingGoogleUser) {
    if (existingGoogleUser.status === USER_STATUSES.SUSPENDED) {
      throw new AppError(
        "Account is suspended",
        403,
        "ACCOUNT_SUSPENDED",
      );
    }

    if (existingGoogleUser.status === USER_STATUSES.DISABLED) {
      throw new AppError(
        "Account is disabled",
        403,
        "ACCOUNT_DISABLED",
      );
    }

    if (existingGoogleUser.status !== USER_STATUSES.ACTIVE) {
      throw new AppError(
        "Account is not active",
        403,
        "ACCOUNT_NOT_ACTIVE",
      );
    }

    const updatedUser = await userRepository.updateLastLoginAt(
      existingGoogleUser._id.toString(),
    );
    const activeUser = updatedUser ?? existingGoogleUser;

    // Ensure TokenBalance exists (idempotent)
    await tokenService.initializeBalance(activeUser._id.toString());

    const accessToken = generateAccessToken({
      sub: activeUser._id.toString(),
      roles: activeUser.roles,
    });

    return {
      user: toSafeUser(activeUser),
      accessToken,
    };
  }

  // 2. New Google identity:
  // Reject auto-merge if an account already exists with this email (Requirement 8)
  const existingEmailUser = await userRepository.findUserByEmail(payload.email);
  if (existingEmailUser) {
    throw new AppError(
      "An account with this email already exists. Please log in with your email and password to link your Google account.",
      409,
      "USER_ALREADY_EXISTS",
    );
  }

  // 3. Provision new user using existing provisioning flow
  let user;
  try {
    user = await userRepository.createUser({
      name: payload.name ?? null,
      email: payload.email,
      googleId: payload.sub,
    });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      throw new AppError(
        "User with this email already exists",
        409,
        "USER_ALREADY_EXISTS",
      );
    }

    throw error;
  }

  // Initialize TokenBalance/free-plan credits through idempotent service
  await tokenService.initializeBalance(user._id.toString());

  const accessToken = generateAccessToken({
    sub: user._id.toString(),
    roles: user.roles,
  });

  return {
    user: toSafeUser(user),
    accessToken,
  };
};


export const linkGoogleAccount = async (
  userId: string,
  input: GoogleAuthInput,
): Promise<{ user: SafeUser; message: string }> => {
  const payload = await verifyGoogleIdToken(input.credential);

  const currentUser = await userRepository.findUserById(userId);
  if (!currentUser) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  if (currentUser.status === USER_STATUSES.SUSPENDED) {
    throw new AppError("Account is suspended", 403, "ACCOUNT_SUSPENDED");
  }

  if (currentUser.status === USER_STATUSES.DISABLED) {
    throw new AppError("Account is disabled", 403, "ACCOUNT_DISABLED");
  }

  if (currentUser.status !== USER_STATUSES.ACTIVE) {
    throw new AppError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE");
  }

  // Check if this Google identity is already linked to the current user
  if (currentUser.googleId === payload.sub) {
    throw new AppError(
      "This Google account is already linked to your profile",
      409,
      "GOOGLE_ALREADY_LINKED",
    );
  }

  // Check if the current user already has a different Google account linked
  if (currentUser.googleId) {
    throw new AppError(
      "Your account is already linked to a different Google account",
      409,
      "ACCOUNT_ALREADY_LINKED",
    );
  }

  // Check if this Google identity is already linked to another NexaMind user
  const existingGoogleUser = await userRepository.findUserByGoogleId(
    payload.sub,
  );
  if (
    existingGoogleUser &&
    existingGoogleUser._id.toString() !== currentUser._id.toString()
  ) {
    throw new AppError(
      "This Google account is already linked to another NexaMind account",
      409,
      "GOOGLE_ACCOUNT_IN_USE",
    );
  }

  let updatedUser;
  try {
    updatedUser = await userRepository.linkGoogleAccount(
      currentUser._id.toString(),
      payload.sub,
    );
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === 11000
    ) {
      throw new AppError(
        "This Google account is already linked to another NexaMind account",
        409,
        "GOOGLE_ACCOUNT_IN_USE",
      );
    }
    throw error;
  }

  const activeUser = updatedUser ?? currentUser;

  return {
    user: toSafeUser(activeUser),
    message: "Google account successfully linked",
  };
};

export const issueWebRefreshToken = async (userId: string): Promise<string> => {
  if (!env.AUTH_RENEWAL_ENABLED) {
    throw new AppError(
      "Authentication renewal feature is not enabled",
      503,
      "FEATURE_DISABLED",
    );
  }

  // Ensure encryption key configuration is valid (fails closed if invalid)
  validateRotationKey();

  const rawRefreshToken = generateRefreshToken();
  const tokenHash = hashToken(rawRefreshToken);
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: new mongoose.Types.ObjectId(userId),
    tokenHash,
    familyId,
    clientType: "web",
    isRevoked: false,
    expiresAt,
  });

  return rawRefreshToken;
};

export const vscodeAuthorize = async (
  userId: string,
  input: VscodeAuthorizeInput,
): Promise<{
  redirectUri: string;
  code: string;
  state: string;
  expiresIn: number;
}> => {
  if (!env.AUTH_RENEWAL_ENABLED) {
    throw new AppError(
      "Authentication renewal feature is not enabled",
      503,
      "FEATURE_DISABLED",
    );
  }

  validateRotationKey();

  const user = await userRepository.findUserById(userId);
  if (!user) {
    throw new AppError("User not found", 401, "UNAUTHORIZED");
  }
  if (user.status !== USER_STATUSES.ACTIVE) {
    throw new AppError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE");
  }

  const requestedUri = input.redirectUri.trim();
  const normalizedRequestedUri = requestedUri.replace(/\/+$/, "");

  const isAllowed = env.VSCODE_ALLOWED_CALLBACK_URIS.some((allowed) => {
    const cleanAllowed = allowed.trim().replace(/\/+$/, "");
    return (
      requestedUri === allowed.trim() ||
      normalizedRequestedUri === cleanAllowed ||
      requestedUri.startsWith(`${cleanAllowed}?`) ||
      requestedUri.startsWith(`${cleanAllowed}#`) ||
      requestedUri.startsWith(`${cleanAllowed}/`)
    );
  });

  if (!isAllowed) {
    throw new AppError(
      "Redirect URI is not allowed",
      400,
      "INVALID_REDIRECT_URI",
    );
  }

  // Generate unpredictable single-use authorization code (32 random bytes = 43 base64url chars)
  const code = crypto.randomBytes(32).toString("base64url");
  const codeHash = hashToken(code);
  const expiresInSeconds = 300; // 5 minutes
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  await AuthorizationCode.create({
    userId: user._id,
    codeHash,
    codeChallenge: input.codeChallenge.trim(),
    codeChallengeMethod: "S256",
    state: input.state.trim(),
    redirectUri: requestedUri,
    expiresAt,
    isUsed: false,
  });

  const separator = requestedUri.includes("?") ? "&" : "?";
  const redirectUri = `${requestedUri}${separator}code=${encodeURIComponent(code)}&state=${encodeURIComponent(input.state.trim())}`;

  return {
    redirectUri,
    code,
    state: input.state.trim(),
    expiresIn: expiresInSeconds,
  };
};

export const vscodeExchange = async (
  input: VscodeExchangeInput,
): Promise<{
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}> => {
  if (!env.AUTH_RENEWAL_ENABLED) {
    throw new AppError(
      "Authentication renewal feature is not enabled",
      503,
      "FEATURE_DISABLED",
    );
  }

  validateRotationKey();

  const codeHash = hashToken(input.code.trim());
  const authCodeDoc = await AuthorizationCode.findOne({ codeHash });

  if (!authCodeDoc) {
    throw new AppError("Invalid authorization code", 400, "INVALID_GRANT");
  }

  if (authCodeDoc.isUsed) {
    throw new AppError(
      "Authorization code has already been used",
      400,
      "INVALID_GRANT",
    );
  }

  if (Date.now() >= authCodeDoc.expiresAt.getTime()) {
    throw new AppError("Authorization code has expired", 400, "INVALID_GRANT");
  }

  if (input.redirectUri && input.redirectUri.trim() !== authCodeDoc.redirectUri) {
    throw new AppError("Redirect URI mismatch", 400, "INVALID_GRANT");
  }

  // Atomically consume code to prevent race conditions and duplicate exchange
  const updatedCode = await AuthorizationCode.findOneAndUpdate(
    { _id: authCodeDoc._id, isUsed: false },
    { $set: { isUsed: true, usedAt: new Date() } },
    { returnDocument: "after" },
  );

  if (!updatedCode) {
    throw new AppError(
      "Authorization code has already been used",
      400,
      "INVALID_GRANT",
    );
  }

  // Verify PKCE verifier using timingSafeEqual
  const computedChallenge = crypto
    .createHash("sha256")
    .update(input.codeVerifier.trim())
    .digest("base64url");

  const a = Buffer.from(computedChallenge);
  const b = Buffer.from(authCodeDoc.codeChallenge);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError("Invalid PKCE code verifier", 400, "INVALID_GRANT");
  }

  // Validate user remains active
  const user = await userRepository.findUserById(authCodeDoc.userId.toString());
  if (!user) {
    throw new AppError("User not found", 401, "UNAUTHORIZED");
  }
  if (user.status === USER_STATUSES.SUSPENDED) {
    throw new AppError("Account is suspended", 403, "ACCOUNT_SUSPENDED");
  }
  if (user.status === USER_STATUSES.DISABLED) {
    throw new AppError("Account is disabled", 403, "ACCOUNT_DISABLED");
  }
  if (user.status !== USER_STATUSES.ACTIVE) {
    throw new AppError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE");
  }

  const accessToken = generateAccessToken({
    sub: user._id.toString(),
    roles: user.roles,
  });

  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    tokenHash: refreshTokenHash,
    familyId,
    clientType: "vscode",
    isRevoked: false,
    expiresAt,
  });

  return {
    user: toSafeUser(user),
    accessToken,
    refreshToken: rawRefreshToken,
  };
};

export interface RefreshSessionOptions {
  token: string;
  expectedClientType?: "web" | "vscode";
  now?: Date | number;
  clock?: () => number;
  key?: string | Buffer;
}

export interface RefreshSessionResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
  clientType: "web" | "vscode";
}

export const refreshSession = async (
  options: RefreshSessionOptions,
): Promise<RefreshSessionResult> => {
  if (!env.AUTH_RENEWAL_ENABLED) {
    throw new AppError(
      "Authentication renewal feature is not enabled",
      503,
      "FEATURE_DISABLED",
    );
  }

  // Fails closed if encryption key is missing or invalid
  validateRotationKey(options.key);

  const rawToken = options.token?.trim();
  if (!rawToken || !/^[0-9a-fA-F]{80}$/.test(rawToken)) {
    throw new AppError("Invalid refresh token format", 401, "INVALID_TOKEN");
  }

  const nowMs =
    typeof options.now === "number"
      ? options.now
      : options.now
        ? options.now.getTime()
        : options.clock
          ? options.clock()
          : Date.now();

  const tokenHash = hashToken(rawToken);
  const oldToken = await RefreshToken.findOne({ tokenHash });

  if (!oldToken) {
    throw new AppError("Invalid refresh token", 401, "INVALID_TOKEN");
  }

  // Reject channel mismatch: browser token cannot be used in VS Code mode, and vice-versa
  if (
    options.expectedClientType &&
    oldToken.clientType !== options.expectedClientType
  ) {
    throw new AppError("Invalid refresh token client channel", 401, "INVALID_TOKEN");
  }

  // Handle revoked or already-rotated token
  if (oldToken.isRevoked) {
    // If it was previously rotated, handle the grace period vs replay attack
    if (oldToken.revokedReason === "ROTATED") {
      // If the session was explicitly logged out or revoked, refuse revival
      const familyRevoked = await RefreshToken.findOne({
        familyId: oldToken.familyId,
        isRevoked: true,
        revokedReason: { $in: ["LOGOUT", "REPLAY_ATTACK", "MANUAL_REVOCATION"] },
      });

      if (familyRevoked) {
        throw new AppError("Session has been revoked", 401, "REVOKED_TOKEN");
      }

      // Check the 20-second rotation cache
      const cachedRotation = await RefreshTokenRotationCache.findOne({
        originalTokenHash: tokenHash,
      });

      // Explicitly check cache expiry in application code
      if (cachedRotation && nowMs < cachedRotation.expiresAt.getTime()) {
        // Within 20-second grace window! Return same successor token safely
        const user = await userRepository.findUserById(oldToken.userId.toString());
        if (!user) {
          throw new AppError("User not found", 401, "UNAUTHORIZED");
        }
        if (user.status === USER_STATUSES.SUSPENDED) {
          throw new AppError("Account is suspended", 403, "ACCOUNT_SUSPENDED");
        }
        if (user.status === USER_STATUSES.DISABLED) {
          throw new AppError("Account is disabled", 403, "ACCOUNT_DISABLED");
        }
        if (user.status !== USER_STATUSES.ACTIVE) {
          throw new AppError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE");
        }

        const successorRawToken = decryptRotationResult(
          {
            encryptedToken: cachedRotation.encryptedSuccessorToken,
            iv: cachedRotation.iv,
            authTag: cachedRotation.authTag,
          },
          options.key,
        );
        const accessToken = generateAccessToken({
          sub: user._id.toString(),
          roles: user.roles,
        });

        return {
          user: toSafeUser(user),
          accessToken,
          refreshToken: successorRawToken,
          clientType: oldToken.clientType,
        };
      }

      // Beyond grace window: Genuine reuse replay attack detected!
      // Revoke the entire token family
      await RefreshToken.updateMany(
        { familyId: oldToken.familyId },
        {
          $set: {
            isRevoked: true,
            revokedAt: new Date(nowMs),
            revokedReason: "REPLAY_ATTACK",
          },
        },
      );
      await RefreshTokenRotationCache.deleteMany({ originalTokenHash: tokenHash });

      throw new AppError(
        "Invalid refresh token: token reuse detected",
        401,
        "REPLAY_ATTACK",
      );
    }

    // Revoked for another reason (e.g. LOGOUT, REPLAY_ATTACK)
    throw new AppError("Refresh token has been revoked", 401, "REVOKED_TOKEN");
  }

  // Check expiration
  if (oldToken.expiresAt.getTime() <= nowMs) {
    throw new AppError("Refresh token has expired", 401, "TOKEN_EXPIRED");
  }

  // Check user active status
  const user = await userRepository.findUserById(oldToken.userId.toString());
  if (!user) {
    throw new AppError("User not found", 401, "UNAUTHORIZED");
  }
  if (user.status === USER_STATUSES.SUSPENDED) {
    throw new AppError("Account is suspended", 403, "ACCOUNT_SUSPENDED");
  }
  if (user.status === USER_STATUSES.DISABLED) {
    throw new AppError("Account is disabled", 403, "ACCOUNT_DISABLED");
  }
  if (user.status !== USER_STATUSES.ACTIVE) {
    throw new AppError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE");
  }

  // Generate new successor token
  const successorRawToken = generateRefreshToken();
  const successorTokenHash = hashToken(successorRawToken);
  const encryptedSuccessor = encryptRotationResult(successorRawToken, options.key);

  const graceExpiresAt = new Date(nowMs + 20 * 1000); // 20-second grace period
  const successorExpiresAt = new Date(nowMs + 30 * 24 * 60 * 60 * 1000); // 30-day successor expiry

  // Perform atomic rotation in MongoDB transaction
  const session = await mongoose.startSession();
  let rotationCompleted = false;

  try {
    await session.withTransaction(async () => {
      // 1. Atomically mark old token as rotated
      const updatedOld = await RefreshToken.findOneAndUpdate(
        { _id: oldToken._id, isRevoked: false },
        {
          $set: {
            isRevoked: true,
            revokedAt: new Date(nowMs),
            revokedReason: "ROTATED",
            replacedByTokenHash: successorTokenHash,
          },
        },
        { session, returnDocument: "after" },
      );

      if (!updatedOld) {
        // Concurrency conflict: another concurrent request rotated first
        return;
      }

      // 2. Insert successor token
      await RefreshToken.create(
        [
          {
            userId: user._id,
            tokenHash: successorTokenHash,
            familyId: oldToken.familyId,
            clientType: oldToken.clientType,
            isRevoked: false,
            expiresAt: successorExpiresAt,
          },
        ],
        { session },
      );

      // 3. Insert rotation cache
      await RefreshTokenRotationCache.create(
        [
          {
            originalTokenHash: tokenHash,
            encryptedSuccessorToken: encryptedSuccessor.encryptedToken,
            iv: encryptedSuccessor.iv,
            authTag: encryptedSuccessor.authTag,
            expiresAt: graceExpiresAt,
          },
        ],
        { session },
      );

      rotationCompleted = true;
    });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      throw err;
    }
    // Check if another concurrent request succeeded while this one hit a conflict
    const checkCache = await RefreshTokenRotationCache.findOne({
      originalTokenHash: tokenHash,
    });
    if (checkCache && nowMs < checkCache.expiresAt.getTime()) {
      const recoveredToken = decryptRotationResult(
        {
          encryptedToken: checkCache.encryptedSuccessorToken,
          iv: checkCache.iv,
          authTag: checkCache.authTag,
        },
        options.key,
      );
      const accessToken = generateAccessToken({
        sub: user._id.toString(),
        roles: user.roles,
      });
      return {
        user: toSafeUser(user),
        accessToken,
        refreshToken: recoveredToken,
        clientType: oldToken.clientType,
      };
    }
    throw new AppError(
      "Failed to rotate refresh token due to database conflict",
      500,
      "ROTATION_FAILED",
    );
  } finally {
    await session.endSession();
  }

  if (!rotationCompleted) {
    // A concurrent request won the rotation race.
    // Check the rotation cache to safely return the winner's successor token!
    const checkCache = await RefreshTokenRotationCache.findOne({
      originalTokenHash: tokenHash,
    });

    if (checkCache && nowMs < checkCache.expiresAt.getTime()) {
      const recoveredToken = decryptRotationResult(
        {
          encryptedToken: checkCache.encryptedSuccessorToken,
          iv: checkCache.iv,
          authTag: checkCache.authTag,
        },
        options.key,
      );
      const accessToken = generateAccessToken({
        sub: user._id.toString(),
        roles: user.roles,
      });
      return {
        user: toSafeUser(user),
        accessToken,
        refreshToken: recoveredToken,
        clientType: oldToken.clientType,
      };
    }

    throw new AppError(
      "Concurrent token rotation failed",
      500,
      "ROTATION_FAILED",
    );
  }

  const accessToken = generateAccessToken({
    sub: user._id.toString(),
    roles: user.roles,
  });

  return {
    user: toSafeUser(user),
    accessToken,
    refreshToken: successorRawToken,
    clientType: oldToken.clientType,
  };
};

export const revokeSession = async (
  rawToken?: string,
): Promise<void> => {
  if (
    !rawToken ||
    typeof rawToken !== "string" ||
    !/^[0-9a-fA-F]{80}$/.test(rawToken.trim())
  ) {
    return; // Idempotent: safe if no token or malformed
  }

  const tokenHash = hashToken(rawToken.trim());
  const tokenDoc = await RefreshToken.findOne({ tokenHash });

  if (!tokenDoc) {
    return; // Idempotent: safe if already unknown
  }

  // Revoke entire token family
  await RefreshToken.updateMany(
    { familyId: tokenDoc.familyId },
    {
      $set: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: "LOGOUT",
      },
    },
  );

  // Clean up any rotation-cache records associated with this family
  const familyTokens = await RefreshToken.find(
    { familyId: tokenDoc.familyId },
    { tokenHash: 1 },
  );
  const familyHashes = familyTokens.map((t) => t.tokenHash);
  await RefreshTokenRotationCache.deleteMany({
    originalTokenHash: { $in: familyHashes },
  });
};


