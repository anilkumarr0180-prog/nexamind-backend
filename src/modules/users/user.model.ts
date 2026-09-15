import { Schema, model } from "mongoose";

export const USER_STATUSES = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  DISABLED: "DISABLED",
} as const;

export const USER_ROLES = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const;

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    status: {
      type: String,
      enum: Object.values(USER_STATUSES),
      default: USER_STATUSES.ACTIVE,
      required: true,
    },

    roles: {
      type: [String],
      enum: Object.values(USER_ROLES),
      default: [USER_ROLES.USER],
      required: true,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
  timestamps: true,
},
);

userSchema.index({ email: 1 }, { unique: true });

export const User = model("User", userSchema);