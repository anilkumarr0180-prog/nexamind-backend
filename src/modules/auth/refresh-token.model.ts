import { Schema, model, type Types } from "mongoose";

export const CLIENT_TYPES = ["web", "vscode"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export interface IRefreshToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  familyId: string;
  clientType: ClientType;
  isRevoked: boolean;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  replacedByTokenHash?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      trim: true,
    },
    familyId: {
      type: String,
      required: true,
      trim: true,
    },
    clientType: {
      type: String,
      enum: CLIENT_TYPES,
      required: true,
    },
    isRevoked: {
      type: Boolean,
      required: true,
      default: false,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      trim: true,
      default: null,
    },
    replacedByTokenHash: {
      type: String,
      trim: true,
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

// 1. Required unique token-hash index for fast lookup and collision prevention
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });

// 2. Family index for fast token family revocation during replay-attack detection
refreshTokenSchema.index({ familyId: 1 });

// 3. User index for active session lookups and account-wide revocations
refreshTokenSchema.index({ userId: 1 });

// 4. Expiration TTL index for asynchronous automatic pruning by MongoDB
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<IRefreshToken>(
  "RefreshToken",
  refreshTokenSchema,
);
