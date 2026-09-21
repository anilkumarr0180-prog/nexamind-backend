import { Schema, model, type Document } from "mongoose";
import type { PlanCode, PlanFeatures } from "./plan.types.js";

export const PLAN_CODES = {
  FREE: "FREE",
  PLUS: "PLUS",
  PRO: "PRO",
} as const;

export const PLAN_CREDITS = {
  [PLAN_CODES.FREE]: 100,
  [PLAN_CODES.PLUS]: 5000,
  [PLAN_CODES.PRO]: 20000,
} as const;

export const CANONICAL_PLAN_CREDITS = PLAN_CREDITS;

export interface IPlan extends Document {
  code: PlanCode;
  name: string;
  description: string;
  monthlyCredits: number;
  features: PlanFeatures;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    code: {
      type: String,
      enum: Object.values(PLAN_CODES),
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    monthlyCredits: {
      type: Number,
      required: true,
      min: [0, "Monthly credits cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message: "Monthly credits must be an integer",
      },
    },

    features: {
      memory: {
        type: Boolean,
        required: true,
        default: false,
      },
      agent: {
        type: Boolean,
        required: true,
        default: false,
      },
      advancedModels: {
        type: Boolean,
        required: true,
        default: false,
      },
    },

    active: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

planSchema.index({ active: 1 });

export const Plan = model<IPlan>("Plan", planSchema);
