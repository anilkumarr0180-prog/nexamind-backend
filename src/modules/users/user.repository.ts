import { User } from "./user.model.js";

export const findUserById = async (userId: string) => {
  return User.findById(userId);
};

export const findUserByEmail = async (
  email: string,
  includePasswordHash = false,
) => {
  const query = User.findOne({ email });

  if (includePasswordHash) {
    query.select("+passwordHash");
  }

  return query.exec();
};

export const createUser = async (data: {
  email: string;
  passwordHash: string;
}) => {
  return User.create(data);
};

export const updateLastLoginAt = async (userId: string) => {
  return User.findByIdAndUpdate(
    userId,
    { lastLoginAt: new Date() },
    { new: true },
  );
};