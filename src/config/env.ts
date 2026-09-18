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

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((val) =>
      val
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter((origin) => origin.length > 0)
    )
    .refine(
      (origins) =>
        origins.every((origin) => {
          try {
            const url = new URL(origin);
            return url.origin === origin;
          } catch {
            return false;
          }
        }),
      {
        message:
          "CORS_ORIGINS must contain valid URL origins without path or trailing slash (e.g. http://localhost:5173)",
      }
    ),

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
    .enum(["ollama", "groq"])
    .default("ollama"),

  GROQ_API_KEY: z
    .string()
    .trim()
    .optional(),

  AI_MODEL: z
    .string()
    .trim()
    .default("qwen/qwen3.8-27b"),

  AI_BASE_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:11434"),

  OLLAMA_TIMEOUT_MS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(60000),

  AI_MAX_CONTEXT_MESSAGES: z
    .coerce
    .number()
    .int()
    .positive()
    .default(20),

  AI_MAX_CONTEXT_CHARS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(32000),

  AI_MAX_MEMORY_CONTEXT: z
    .coerce
    .number()
    .int()
    .positive()
    .default(10),

  AI_MAX_EXTRACTED_MEMORIES_PER_CHAT: z
    .coerce
    .number()
    .int()
    .positive()
    .default(3),

  AI_EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(1)
    .default("nomic-embed-text"),

  AI_MEMORY_SEMANTIC_SEARCH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((val) => val === "true"),

  AI_MEMORY_MIN_SCORE: z
    .coerce
    .number()
    .min(0)
    .max(1)
    .default(0.65),

  AI_MEMORY_TEXT_MIN_SCORE: z
    .coerce
    .number()
    .min(0)
    .max(1)
    .default(0.25),

  AUTH_RATE_LIMIT_WINDOW_MS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),

  AUTH_RATE_LIMIT_MAX: z
    .coerce
    .number()
    .int()
    .positive()
    .default(20),

  AI_RATE_LIMIT_WINDOW_MS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),

  AI_RATE_LIMIT_MAX: z
    .coerce
    .number()
    .int()
    .positive()
    .default(50),
}).superRefine((data, ctx) => {
  if (data.AI_PROVIDER === "groq" && (!data.GROQ_API_KEY || data.GROQ_API_KEY.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GROQ_API_KEY is required when AI_PROVIDER is set to groq",
      path: ["GROQ_API_KEY"],
    });
  }
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment configuration:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsedEnv.data;