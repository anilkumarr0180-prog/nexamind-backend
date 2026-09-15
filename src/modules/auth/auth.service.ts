import { AppError } from "../../errors/app.error.js";
import { USER_STATUSES } from "../users/user.model.js";
import * as userRepository from "../users/user.repository.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { generateAccessToken } from "../../utils/jwt.js";
import type { LoginInput, RegisterInput } from "./auth.validation.js";

export type SafeUser = {
  id: string;
  email: string;
  status: string;
  roles: string[];
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
  email: string;
  status: string;
  roles: string[];
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): SafeUser => ({
  id: user._id.toString(),
  email: user.email,
  status: user.status,
  roles: [...user.roles],
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt ?? new Date(),
  updatedAt: user.updatedAt ?? new Date(),
});

export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const normalizedEmail = input.email.trim().toLowerCase();

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

  if (!user) {
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
