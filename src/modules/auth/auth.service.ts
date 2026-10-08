import { AppError } from "../../errors/app.error.js";
import { USER_STATUSES } from "../users/user.model.js";
import * as userRepository from "../users/user.repository.js";
import * as tokenService from "../tokens/token.service.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { generateAccessToken } from "../../utils/jwt.js";
import type {
  GoogleAuthInput,
  LoginInput,
  RegisterInput,
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
