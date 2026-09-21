import { Schema, model } from "mongoose";
import {
  CREDIT_TRANSACTION_TYPES,
  type ICreditTransaction,
} from "./credit-transaction.types.js";

const creditTransactionSchema =
  new Schema<ICreditTransaction>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },

      type: {
        type: String,
        enum: CREDIT_TRANSACTION_TYPES,
        required: true,
        index: true,
      },

      amount: {
        type: Number,
        required: true,
        min: [0, "Transaction amount cannot be negative"],
        validate: {
          validator: Number.isInteger,
          message: "Transaction amount must be an integer",
        },
      },

      balanceBefore: {
        type: Number,
        required: true,
        min: [0, "Balance before cannot be negative"],
        validate: {
          validator: Number.isInteger,
          message: "Balance before must be an integer",
        },
      },

      balanceAfter: {
        type: Number,
        required: true,
        min: [0, "Balance after cannot be negative"],
        validate: {
          validator: Number.isInteger,
          message: "Balance after must be an integer",
        },
      },

      referenceId: {
        type: String,
        trim: true,
        default: null,
      },

      description: {
        type: String,
        trim: true,
        maxlength: 500,
        default: null,
      },
    },
    {
      timestamps: {
        createdAt: true,
        updatedAt: false,
      },
    },
  );

creditTransactionSchema.index({
  userId: 1,
  createdAt: -1,
});

creditTransactionSchema.index({
  userId: 1,
  type: 1,
  createdAt: -1,
});

/**
 * Prevent duplicate transactions for the same
 * user + transaction type + reference.
 *
 * Example:
 * userId + PLAN_GRANT + polar-event-123
 *
 * can only exist once.
 */
creditTransactionSchema.index(
  {
    userId: 1,
    type: 1,
    referenceId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      referenceId: {
        $type: "string",
      },
    },
  },
);

export const CreditTransaction =
  model<ICreditTransaction>(
    "CreditTransaction",
    creditTransactionSchema,
  );