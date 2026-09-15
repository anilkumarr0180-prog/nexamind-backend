import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z
    .coerce
    .number()
    .int()
    .positive()
    .default(5000),

  MONGODB_URI: z
    .string()
    .trim()
    .min(1, "MONGODB_URI is required"),

  JWT_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_SECRET must be at least 32 characters"),

  JWT_ACCESS_EXPIRES_IN: z
    .string()
    .trim()
    .regex(
      /^\d+(s|m|h|d|w|y)$/,
      "JWT_ACCESS_EXPIRES_IN must use a valid duration such as 15m, 1h, or 7d",
    )
    .default("15m"),

  AI_PROVIDER: z
    .string()
    .trim()
    .min(1)
    .default("ollama"),

  AI_MODEL: z
    .string()
    .trim()
    .min(1, "AI_MODEL is required"),

  AI_BASE_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:11434"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment configuration:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsedEnv.data;