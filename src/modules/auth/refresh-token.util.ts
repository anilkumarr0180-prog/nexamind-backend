import crypto from "node:crypto";
import { env } from "../../config/env.js";

export interface EncryptedRotationResult {
  encryptedToken: string;
  iv: string;
  authTag: string;
}

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_STRICT_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Validates and converts an AES-256-GCM rotation encryption key.
 *
 * Rules:
 * - Key must resolve to exactly 32 bytes (256 bits).
 * - Key must never match JWT_SECRET.
 * - When no explicit key is provided, falls back to env.ROTATION_ENCRYPTION_KEY.
 * - Fails closed if no valid key is configured or provided.
 * - Never prints or leaks key material in error messages.
 */
export const validateRotationKey = (key?: string | Buffer): Buffer => {
  let candidate: string | Buffer | undefined = key;

  if (candidate === undefined) {
    candidate = env.ROTATION_ENCRYPTION_KEY;
  }

  if (!candidate) {
    throw new Error(
      "Rotation encryption key is not configured or provided. Operation failed closed.",
    );
  }

  if (Buffer.isBuffer(candidate)) {
    if (candidate.length !== 32) {
      throw new Error(
        "Invalid rotation encryption key: key buffer must be exactly 32 bytes (256 bits)",
      );
    }
    return candidate;
  }

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();

    if (!HEX_64_REGEX.test(trimmed)) {
      throw new Error(
        "Invalid rotation encryption key: key must be a 64-character hexadecimal string representing a 256-bit key",
      );
    }

    if (env.JWT_SECRET && trimmed === env.JWT_SECRET.trim()) {
      throw new Error(
        "Invalid rotation encryption key: rotation key must be separate and distinct from JWT_SECRET",
      );
    }

    const keyBuffer = Buffer.from(trimmed, "hex");
    if (keyBuffer.length !== 32) {
      throw new Error(
        "Invalid rotation encryption key: decoded key must be exactly 32 bytes (256 bits)",
      );
    }

    return keyBuffer;
  }

  throw new Error("Invalid rotation encryption key format");
};

/**
 * Generates an opaque, cryptographically secure refresh token with 40 bytes of entropy.
 * Returns an 80-character lowercase hexadecimal string.
 */
export const generateRefreshToken = (): string => {
  return crypto.randomBytes(40).toString("hex");
};

/**
 * Computes a deterministic SHA-256 hash of a refresh token.
 * Used for database storage and lookups without ever exposing or persisting raw tokens.
 */
export const hashToken = (token: string): string => {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Token must be a non-empty string");
  }

  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * Encrypts a short-lived successor token using AES-256-GCM.
 * Uses a unique 12-byte (96-bit) initialization vector per encryption.
 */
export const encryptRotationResult = (
  plaintext: string,
  keyOrOptions?: string | Buffer | { key?: string | Buffer },
): EncryptedRotationResult => {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Plaintext must be a non-empty string");
  }

  const customKey =
    typeof keyOrOptions === "object" && keyOrOptions !== null && !Buffer.isBuffer(keyOrOptions)
      ? keyOrOptions.key
      : (keyOrOptions as string | Buffer | undefined);

  const keyBuffer = validateRotationKey(customKey);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encryptedToken: encrypted,
    iv: iv.toString("hex"),
    authTag,
  };
};

/**
 * Decrypts a short-lived successor token using AES-256-GCM.
 * Validates ciphertext, IV, authentication tag, and key integrity.
 * Fails closed on any tampering or malformed payload.
 */
export const decryptRotationResult = (
  data: EncryptedRotationResult,
  keyOrOptions?: string | Buffer | { key?: string | Buffer },
): string => {
  if (!data || typeof data !== "object") {
    throw new Error("Malformed encrypted rotation result: payload must be an object");
  }

  const { encryptedToken, iv, authTag } = data;

  if (
    typeof encryptedToken !== "string" ||
    typeof iv !== "string" ||
    typeof authTag !== "string"
  ) {
    throw new Error(
      "Malformed encrypted rotation result: encryptedToken, iv, and authTag must be strings",
    );
  }

  if (encryptedToken.length === 0 || !HEX_STRICT_REGEX.test(encryptedToken)) {
    throw new Error(
      "Malformed encrypted rotation result: encryptedToken must be a non-empty hexadecimal string",
    );
  }

  // AES-GCM standard IV: 12 bytes (24 hex) or 16 bytes (32 hex)
  if ((iv.length !== 24 && iv.length !== 32) || !HEX_STRICT_REGEX.test(iv)) {
    throw new Error(
      "Malformed encrypted rotation result: iv must be a valid 24 or 32 character hexadecimal string",
    );
  }

  // AES-GCM auth tag: 16 bytes (32 hex characters)
  if (authTag.length !== 32 || !HEX_STRICT_REGEX.test(authTag)) {
    throw new Error(
      "Malformed encrypted rotation result: authTag must be a 32 character hexadecimal string",
    );
  }

  const customKey =
    typeof keyOrOptions === "object" && keyOrOptions !== null && !Buffer.isBuffer(keyOrOptions)
      ? keyOrOptions.key
      : (keyOrOptions as string | Buffer | undefined);

  const keyBuffer = validateRotationKey(customKey);

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyBuffer,
      Buffer.from(iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "hex"));

    let decrypted = decipher.update(encryptedToken, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    throw new Error(
      "Decryption failed: ciphertext, IV, or authentication tag is invalid or tampered",
    );
  }
};

/**
 * Checks whether an explicit expiration timestamp has passed.
 * Application logic must verify expiration itself since MongoDB TTL is asynchronous.
 */
export const isRotationCacheExpired = (expiresAt: Date | string | number): boolean => {
  const expiryTime = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryTime)) {
    return true;
  }
  return Date.now() >= expiryTime;
};
