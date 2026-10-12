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
  keyGenerator?: (req: Request) => string;
}

export const createRateLimiter = (
  options: CustomRateLimiterOptions,
): { limiter: RateLimitRequestHandler; store: MemoryStore } => {
  const store = options.store || new MemoryStore();
  const errorMessage =
    options.message || "Too many requests, please try again later.";

  const defaultKeyGen = (req: Request): string => {
    // Identity is locked to the socket remote address / normalized IP
    // Arbitrary user-controlled headers (e.g. X-Forwarded-For) are not trusted for identity
    return ipKeyGenerator(req.ip || req.socket.remoteAddress || "127.0.0.1");
  };

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
    keyGenerator: options.keyGenerator || defaultKeyGen,
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

// Independent in-memory stores for Auth, AI, and Voice
export const authRateLimitStore = new MemoryStore();
export const aiRateLimitStore = new MemoryStore();
export const voiceRateLimitStore = new MemoryStore();

// Auth Rate Limiter (POST /api/v1/auth/register, POST /api/v1/auth/login)
export const { limiter: authRateLimiter } = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: "Too many authentication attempts, please try again later.",
  store: authRateLimitStore,
});

// AI Rate Limiter (POST /api/v1/ai/chat)
// Dedicated rate limit keyed by authenticated user (falling back to client IP)
export const { limiter: aiRateLimiter } = createRateLimiter({
  windowMs: env.AI_RATE_LIMIT_WINDOW_MS,
  limit: env.AI_RATE_LIMIT_MAX,
  message: "Too many AI chat requests, please try again later.",
  store: aiRateLimitStore,
  keyGenerator: (req: Request): string => {
    const authUser = (req as any).user;
    if (authUser && (authUser.userId || authUser.sub)) {
      return `user:${authUser.userId || authUser.sub}`;
    }
    return ipKeyGenerator(req.ip || req.socket.remoteAddress || "127.0.0.1");
  },
});

// Voice Rate Limiter (POST /api/v1/voice/transcribe)
// Dedicated rate limit keyed by authenticated user (falling back to client IP)
export const { limiter: voiceRateLimiter } = createRateLimiter({
  windowMs: env.VOICE_RATE_LIMIT_WINDOW_MS,
  limit: env.VOICE_RATE_LIMIT_MAX,
  message: "Too many voice transcription requests, please try again later.",
  store: voiceRateLimitStore,
  keyGenerator: (req: Request): string => {
    const authUser = (req as any).user;
    if (authUser && (authUser.userId || authUser.sub)) {
      return `user:${authUser.userId || authUser.sub}`;
    }
    return ipKeyGenerator(req.ip || req.socket.remoteAddress || "127.0.0.1");
  },
});

// Test / maintenance reset helpers
export const resetAuthRateLimit = async (): Promise<void> => {
  await authRateLimitStore.resetAll();
};

export const resetAiRateLimit = async (): Promise<void> => {
  await aiRateLimitStore.resetAll();
};

export const resetVoiceRateLimit = async (): Promise<void> => {
  await voiceRateLimitStore.resetAll();
};
