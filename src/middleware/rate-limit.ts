import { rateLimit, MemoryStore, ipKeyGenerator } from "express-rate-limit";
import type { Options, RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Process-Local API Rate Limiting Middleware
 *
 * NOTE: This rate limiter uses an in-memory store (MemoryStore) local to the Node.js process.
 * In a multi-instance or cluster environment, rate limits are enforced per-process rather than
 * globally across all instances. For production deployments with horizontal scaling,
 * a distributed shared store (such as Redis) should be introduced.
 */

export interface CustomRateLimiterOptions {
  windowMs: number;
  limit: number;
  message?: string;
  store?: MemoryStore;
}

export const createRateLimiter = (
  options: CustomRateLimiterOptions,
): { limiter: RateLimitRequestHandler; store: MemoryStore } => {
  const store = options.store || new MemoryStore();
  const errorMessage =
    options.message || "Too many requests, please try again later.";

  const limiter = rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    validate: {
      xForwardedForHeader: false,
      default: true,
    },
    keyGenerator: (req: Request): string => {
      // Identity is locked to the socket remote address / normalized IP
      // Arbitrary user-controlled headers (e.g. X-Forwarded-For) are not trusted for identity
      return ipKeyGenerator(req.ip || req.socket.remoteAddress || "127.0.0.1");
    },
    handler: (_req: Request, res: Response, _next, options: Options) => {
      res.status(options.statusCode).json({
        success: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: errorMessage,
        },
      });
    },
  });

  return { limiter, store };
};

// Independent in-memory stores for Auth and AI
export const authRateLimitStore = new MemoryStore();
export const aiRateLimitStore = new MemoryStore();

// Auth Rate Limiter (POST /api/v1/auth/register, POST /api/v1/auth/login)
export const { limiter: authRateLimiter } = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: "Too many authentication attempts, please try again later.",
  store: authRateLimitStore,
});

// AI Rate Limiter (POST /api/v1/ai/chat)
export const { limiter: aiRateLimiter } = createRateLimiter({
  windowMs: env.AI_RATE_LIMIT_WINDOW_MS,
  limit: env.AI_RATE_LIMIT_MAX,
  message: "Too many AI chat requests, please try again later.",
  store: aiRateLimitStore,
});

// Test / maintenance reset helpers
export const resetAuthRateLimit = async (): Promise<void> => {
  await authRateLimitStore.resetAll();
};

export const resetAiRateLimit = async (): Promise<void> => {
  await aiRateLimitStore.resetAll();
};
