import { Schema, model, type Types } from "mongoose";

export interface IAuthorizationCode {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  codeHash: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  redirectUri: string;
  isUsed: boolean;
  usedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const authorizationCodeSchema = new Schema<IAuthorizationCode>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    codeHash: {
      type: String,
      required: true,
      trim: true,
    },
    codeChallenge: {
      type: String,
      required: true,
      trim: true,
    },
    codeChallengeMethod: {
      type: String,
      required: true,
      default: "S256",
      enum: ["S256"],
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    redirectUri: {
      type: String,
      required: true,
      trim: true,
    },
    isUsed: {
      type: Boolean,
      required: true,
      default: false,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// 1. Unique index on codeHash for instant lookup and collision prevention
authorizationCodeSchema.index({ codeHash: 1 }, { unique: true });

// 2. TTL index to automatically clean up expired authorization codes after 5 minutes
authorizationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// 3. Index on userId for user tracking and cleanup
authorizationCodeSchema.index({ userId: 1 });

export const AuthorizationCode = model<IAuthorizationCode>(
  "AuthorizationCode",
  authorizationCodeSchema,
);
