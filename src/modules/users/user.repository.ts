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

export const findUserByGoogleId = async (
  googleId: string,
  includePasswordHash = false,
) => {
  const query = User.findOne({ googleId });

  if (includePasswordHash) {
    query.select("+passwordHash");
  }

  return query.exec();
};

export const createUser = async (data: {
  email: string;
  passwordHash?: string;
  googleId?: string;
  name?: string | null;
}) => {
  return User.create(data);
};

export const updateLastLoginAt = async (userId: string) => {
  return User.findByIdAndUpdate(
    userId,
    { lastLoginAt: new Date() },
    { returnDocument: "after" },
  );
};
export const linkGoogleAccount = async (
  userId: string,
  googleId: string,
) => {
  return User.findByIdAndUpdate(
    userId,
    { googleId },
    { returnDocument: "after" },
  );
};
