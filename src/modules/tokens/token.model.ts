import { Schema, model, type Types } from "mongoose";

export interface ITokenBalance {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

const tokenBalanceSchema = new Schema<ITokenBalance>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    balance: {
      type: Number,
      required: true,
      min: [0, "Balance cannot be negative"],
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

tokenBalanceSchema.index({ userId: 1 }, { unique: true });

export const TokenBalance = model<ITokenBalance>(
  "TokenBalance",
  tokenBalanceSchema,
);
