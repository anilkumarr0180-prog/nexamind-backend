import { z } from "zod";

export const registerSchema = z.object({
  body: z.object({
    name: z
      .string()
      .trim()
      .min(1, "Name cannot be empty")
      .max(100, "Name must not exceed 100 characters")
      .optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email format"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128, "Password must not exceed 128 characters"),
  }),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const loginSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email format"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128, "Password must not exceed 128 characters"),
  }),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const googleAuthSchema = z.object({
  body: z.object({
    credential: z
      .string()
      .trim()
      .min(1, "Credential is required"),
  }),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const vscodeAuthorizeSchema = z.object({
  body: z.preprocess(
    (val: unknown) => {
      if (typeof val === "object" && val !== null) {
        const obj = val as Record<string, unknown>;
        return {
          codeChallenge: obj.codeChallenge ?? obj.code_challenge,
          codeChallengeMethod:
            obj.codeChallengeMethod ?? obj.code_challenge_method ?? "S256",
          state: obj.state,
          redirectUri:
            obj.redirectUri ??
            obj.redirect_uri ??
            obj.callbackUri ??
            obj.callback_uri,
        };
      }
      return val;
    },
    z.object({
      codeChallenge: z
        .string()
        .trim()
        .min(43, "Code challenge must be at least 43 characters")
        .max(128, "Code challenge must not exceed 128 characters")
        .regex(
          /^[A-Za-z0-9\-_=]+$/,
          "Code challenge must be a valid base64url string",
        ),
      codeChallengeMethod: z
        .literal("S256", {
          message: "Only S256 code challenge method is supported",
        })
        .default("S256"),
      state: z
        .string()
        .trim()
        .min(8, "State must be at least 8 characters")
        .max(256, "State must not exceed 256 characters"),
      redirectUri: z
        .string()
        .trim()
        .min(1, "Redirect URI is required"),
    }),
  ),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const vscodeExchangeSchema = z.object({
  body: z.preprocess(
    (val: unknown) => {
      if (typeof val === "object" && val !== null) {
        const obj = val as Record<string, unknown>;
        return {
          code: obj.code,
          codeVerifier: obj.codeVerifier ?? obj.code_verifier,
          redirectUri: obj.redirectUri ?? obj.redirect_uri,
        };
      }
      return val;
    },
    z.object({
      code: z
        .string()
        .trim()
        .min(1, "Authorization code is required"),
      codeVerifier: z
        .string()
        .trim()
        .min(43, "Code verifier must be at least 43 characters")
        .max(128, "Code verifier must not exceed 128 characters")
        .regex(
          /^[A-Za-z0-9\-._~]+$/,
          "Code verifier must contain only unreserved characters (RFC 7636)",
        ),
      redirectUri: z
        .string()
        .trim()
        .optional(),
    }),
  ),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const refreshSchema = z.object({
  body: z
    .object({
      refreshToken: z
        .string()
        .trim()
        .regex(/^[0-9a-fA-F]{80}$/, "Invalid refresh token format")
        .optional(),
    })
    .optional()
    .default({}),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const logoutSchema = z.object({
  body: z
    .object({
      refreshToken: z
        .string()
        .trim()
        .optional(),
    })
    .optional()
    .default({}),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>["body"];
export type LoginInput = z.infer<typeof loginSchema>["body"];
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>["body"];
export type VscodeAuthorizeInput = z.infer<typeof vscodeAuthorizeSchema>["body"];
export type VscodeExchangeInput = z.infer<typeof vscodeExchangeSchema>["body"];
export type RefreshInput = z.infer<typeof refreshSchema>["body"];
export type LogoutInput = z.infer<typeof logoutSchema>["body"];
