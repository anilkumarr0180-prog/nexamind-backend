import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { Plan, PLAN_CODES } from "./plan.model.js";
import type { PlanCode } from "./plan.types.js";

interface SeedPlan {
  code: PlanCode;
  name: string;
  description: string;
  monthlyCredits: number;
  features: {
    memory: boolean;
    agent: boolean;
    advancedModels: boolean;
  };
  active: boolean;
}

const SEED_PLANS: SeedPlan[] = [
  {
    code: PLAN_CODES.FREE,
    name: "Free",
    description:
      "Get started with NexaMind at no cost. Perfect for personal use and experimentation.",
    monthlyCredits: 100,
    features: {
      memory: false,
      agent: false,
      advancedModels: false,
    },
    active: true,
  },
  {
    code: PLAN_CODES.PLUS,
    name: "Plus",
    description:
      "Boost your productivity with more credits and access to memory and agent features.",
    monthlyCredits: 5000,
    features: {
      memory: true,
      agent: true,
      advancedModels: false,
    },
    active: true,
  },
  {
    code: PLAN_CODES.PRO,
    name: "Pro",
    description:
      "Unlock the full power of NexaMind with maximum credits, advanced models, memory, and agents.",
    monthlyCredits: 20000,
    features: {
      memory: true,
      agent: true,
      advancedModels: true,
    },
    active: true,
  },
];

const seedPlans = async (): Promise<void> => {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGODB_URI);
  console.log("MongoDB connected");

  console.log("Seeding plans (idempotent upsert)...");

  for (const planData of SEED_PLANS) {
    const result = await Plan.findOneAndUpdate(
      { code: planData.code },
      { $set: planData },
      { upsert: true, returnDocument: "after", runValidators: true },
    );

    console.log(
      `  ✓ [${result.code}] "${result.name}" — ${result.monthlyCredits} credits/month`,
    );
  }

  console.log(`\nDone. ${SEED_PLANS.length} plans upserted.`);

  await mongoose.disconnect();
  console.log("MongoDB disconnected");
};

seedPlans().catch((error: unknown) => {
  console.error("Plan seed failed:", error);
  process.exitCode = 1;
  void mongoose.disconnect();
});
