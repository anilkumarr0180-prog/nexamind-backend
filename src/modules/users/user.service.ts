import { AppError } from "../../errors/app.error.js";
import { USER_ROLES } from "./user.model.js";
import * as userRepository from "./user.repository.js";

export const getUserById = async (
  userId: string,
  requestingUser: { userId: string; roles: string[] },
) => {
  const isSelf = requestingUser.userId === userId;
  const isAdmin = requestingUser.roles.includes(USER_ROLES.ADMIN);

  if (!isSelf && !isAdmin) {
    throw new AppError(
      "You do not have permission to access this user profile",
      403,
      "FORBIDDEN",
    );
  }

  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new AppError(
      "User not found",
      404,
      "USER_NOT_FOUND",
    );
  }

  return user;
};

export const getUserByEmail = async (email: string) => {
  return userRepository.findUserByEmail(email);
};

export const registerUser = async (data: {
  email: string;
  passwordHash: string;
}) => {
  const existingUser = await userRepository.findUserByEmail(data.email);

  if (existingUser) {
    throw new Error("User with this email already exists");
  }

  return userRepository.createUser(data);
};