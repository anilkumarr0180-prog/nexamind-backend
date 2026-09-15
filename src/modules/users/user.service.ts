import { AppError } from "../../errors/app.error.js";
import * as userRepository from "./user.repository.js";

export const getUserById = async (userId: string) => {
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