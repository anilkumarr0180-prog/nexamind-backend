import { OAuth2Client } from "google-auth-library";
import { AppError } from "../../errors/app.error.js";
import { env } from "../../config/env.js";

export interface GoogleVerifiedPayload {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  picture?: string | null;
}

export type GoogleTokenVerifier = (
  credential: string,
  expectedClientId?: string,
) => Promise<GoogleVerifiedPayload>;

/**
 * Validates Google payload claims according to security requirements:
 * - issuer (accounts.google.com or https://accounts.google.com)
 * - audience (matches expected GOOGLE_CLIENT_ID)
 * - expiry (exp > now)
 * - required subject (sub)
 * - email
 */
export const validateGooglePayloadClaims = (
  payload: {
    iss?: string;
    aud?: string;
    exp?: number;
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  },
  expectedClientId: string,
): GoogleVerifiedPayload => {
  // 1. Issuer check
  if (
    !payload.iss ||
    (payload.iss !== "accounts.google.com" &&
      payload.iss !== "https://accounts.google.com")
  ) {
    throw new AppError(
      "Invalid Google token issuer",
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  // 2. Audience check using GOOGLE_CLIENT_ID
  if (!payload.aud || payload.aud !== expectedClientId) {
    throw new AppError(
      "Google token audience mismatch",
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  // 3. Expiry check
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSeconds) {
    throw new AppError(
      "Google token has expired",
      401,
      "GOOGLE_TOKEN_EXPIRED",
    );
  }

  // 4. Required sub
  if (
    !payload.sub ||
    typeof payload.sub !== "string" ||
    payload.sub.trim().length === 0
  ) {
    throw new AppError(
      "Google token missing required subject (sub)",
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  // 5. Email check
  if (
    !payload.email ||
    typeof payload.email !== "string" ||
    payload.email.trim().length === 0
  ) {
    throw new AppError(
      "Google token missing email",
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  return {
    sub: payload.sub.trim(),
    email: payload.email.trim().toLowerCase(),
    emailVerified: payload.email_verified ?? false,
    name: payload.name ? payload.name.trim() : null,
    picture: payload.picture ?? null,
  };
};

/**
 * Default production verifier using google-auth-library OAuth2Client
 */
export const defaultGoogleTokenVerifier: GoogleTokenVerifier = async (
  credential: string,
  expectedClientId?: string,
): Promise<GoogleVerifiedPayload> => {
  const clientId =
    expectedClientId || env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new AppError(
      "Google authentication is not configured on the server (missing GOOGLE_CLIENT_ID)",
      500,
      "GOOGLE_AUTH_NOT_CONFIGURED",
    );
  }

  let ticket;
  try {
    const client = new OAuth2Client(clientId);
    ticket = await client.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Token verification failed";
    if (/token used too late|expired/i.test(message)) {
      throw new AppError(
        "Google token has expired",
        401,
        "GOOGLE_TOKEN_EXPIRED",
      );
    }
    if (/wrong recipient|audience/i.test(message)) {
      throw new AppError(
        "Google token audience mismatch",
        401,
        "INVALID_GOOGLE_TOKEN",
      );
    }
    if (/issuer/i.test(message)) {
      throw new AppError(
        "Invalid Google token issuer",
        401,
        "INVALID_GOOGLE_TOKEN",
      );
    }
    throw new AppError(
      `Invalid Google token: ${message}`,
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new AppError(
      "Invalid Google token payload",
      401,
      "INVALID_GOOGLE_TOKEN",
    );
  }

  return validateGooglePayloadClaims(payload, clientId);
};

let currentVerifier: GoogleTokenVerifier = defaultGoogleTokenVerifier;

export const setGoogleTokenVerifier = (
  verifier: GoogleTokenVerifier,
): void => {
  currentVerifier = verifier;
};

export const resetGoogleTokenVerifier = (): void => {
  currentVerifier = defaultGoogleTokenVerifier;
};

export const verifyGoogleIdToken: GoogleTokenVerifier = (
  credential: string,
  expectedClientId?: string,
): Promise<GoogleVerifiedPayload> => {
  return currentVerifier(credential, expectedClientId);
};
