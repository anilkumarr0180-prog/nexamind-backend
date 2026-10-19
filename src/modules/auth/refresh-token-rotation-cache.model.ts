import { Schema, model, type Types } from "mongoose";

export interface IRefreshTokenRotationCache {
  _id: Types.ObjectId;
  originalTokenHash: string;
  encryptedSuccessorToken: string;
  iv: string;
  authTag: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenRotationCacheSchema =
  new Schema<IRefreshTokenRotationCache>(
    {
      originalTokenHash: {
        type: String,
        required: true,
        trim: true,
      },
      encryptedSuccessorToken: {
        type: String,
        required: true,
        trim: true,
      },
      iv: {
        type: String,
        required: true,
        trim: true,
      },
      authTag: {
        type: String,
        required: true,
        trim: true,
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

// 1. Unique lookup index on original token hash for rotation race window / retry recovery
refreshTokenRotationCacheSchema.index(
  { originalTokenHash: 1 },
  { unique: true },
);

// 2. Short-lived TTL index for asynchronous pruning of expired rotation cache entries
refreshTokenRotationCacheSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export const RefreshTokenRotationCache =
  model<IRefreshTokenRotationCache>(
    "RefreshTokenRotationCache",
    refreshTokenRotationCacheSchema,
  );
