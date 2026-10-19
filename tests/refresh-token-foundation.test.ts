import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { User } from "../src/modules/users/user.model.js";
import {
  RefreshToken,
  CLIENT_TYPES,
} from "../src/modules/auth/refresh-token.model.js";
import {
  RefreshTokenRotationCache,
} from "../src/modules/auth/refresh-token-rotation-cache.model.js";
import {
  generateRefreshToken,
  hashToken,
  validateRotationKey,
  encryptRotationResult,
  decryptRotationResult,
  isRotationCacheExpired,
} from "../src/modules/auth/refresh-token.util.js";

const runTests = async () => {
  console.log("=== Starting NexaMind Refresh Token & Crypto Foundation Test Suite (Phase 2.1) ===");

  const validTestKeyHex = crypto.randomBytes(32).toString("hex");
  const testPlaintoken = generateRefreshToken();

  // -------------------------------------------------------------
  // Test 1: Refresh-token generation and format
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing refresh-token generation and format...");
  const token1 = generateRefreshToken();
  const token2 = generateRefreshToken();

  assert.equal(typeof token1, "string", "Token must be a string");
  assert.equal(token1.length, 80, "40 bytes in hex must produce an 80-character string");
  assert.match(token1, /^[0-9a-f]{80}$/, "Token must contain only lowercase hexadecimal characters");
  assert.notEqual(token1, token2, "Subsequent token generations must produce unique high-entropy tokens");
  console.log("✓ Refresh-token generation produces 80-char opaque hex tokens with 40 bytes of entropy");

  // -------------------------------------------------------------
  // Test 2: Consistent SHA-256 hashing without exposing raw tokens
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing consistent SHA-256 hashing without exposing raw tokens...");
  const hash1 = hashToken(token1);
  const hash1Repeat = hashToken(token1);
  const hash2 = hashToken(token2);

  assert.equal(hash1, hash1Repeat, "Hashing the same token must produce deterministic output");
  assert.notEqual(hash1, hash2, "Different tokens must produce different hashes");
  assert.equal(hash1.length, 64, "SHA-256 hash must be 64 hexadecimal characters");
  assert.match(hash1, /^[0-9a-f]{64}$/, "Hash must be valid lowercase hex");
  assert.ok(!hash1.includes(token1), "Hash must never contain the plaintext raw token");

  assert.throws(
    () => hashToken(""),
    /Token must be a non-empty string/,
    "Empty token string must be rejected",
  );
  assert.throws(
    // @ts-expect-error Testing non-string input rejection
    () => hashToken(null),
    /Token must be a non-empty string/,
    "Non-string input must be rejected",
  );
  console.log("✓ Deterministic SHA-256 hashing confirmed without raw token exposure");

  // -------------------------------------------------------------
  // Test 3: Successful AES-256-GCM round-trip
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing successful AES-256-GCM encryption and decryption round-trip...");
  const encrypted = encryptRotationResult(testPlaintoken, { key: validTestKeyHex });

  assert.ok(encrypted.encryptedToken, "encryptedToken must be present");
  assert.ok(encrypted.iv, "iv must be present");
  assert.ok(encrypted.authTag, "authTag must be present");
  assert.equal(encrypted.iv.length, 24, "12-byte IV must be 24 hex characters");
  assert.equal(encrypted.authTag.length, 32, "16-byte authTag must be 32 hex characters");
  assert.notEqual(encrypted.encryptedToken, testPlaintoken, "Ciphertext must not match plaintext");

  const decrypted = decryptRotationResult(encrypted, { key: validTestKeyHex });
  assert.equal(decrypted, testPlaintoken, "Decrypted text must match original plaintext");

  // Also test with Buffer key
  const bufferKey = Buffer.from(validTestKeyHex, "hex");
  const encryptedWithBuf = encryptRotationResult("test-token-payload", { key: bufferKey });
  const decryptedWithBuf = decryptRotationResult(encryptedWithBuf, { key: bufferKey });
  assert.equal(decryptedWithBuf, "test-token-payload", "Buffer key encryption/decryption roundtrip succeeded");
  console.log("✓ AES-256-GCM roundtrip verified with both hex string and Buffer keys");

  // -------------------------------------------------------------
  // Test 4: Decryption failure when ciphertext, IV, or authTag is tampered with
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing decryption failure on tampered ciphertext, IV, or authentication tag...");

  // Tamper ciphertext: flip the first hex character
  const tamperedCipher = {
    ...encrypted,
    encryptedToken:
      (encrypted.encryptedToken[0] === "a" ? "b" : "a") +
      encrypted.encryptedToken.slice(1),
  };
  assert.throws(
    () => decryptRotationResult(tamperedCipher, { key: validTestKeyHex }),
    /Decryption failed: ciphertext, IV, or authentication tag is invalid or tampered/,
    "Tampered ciphertext must cause decryption to fail closed",
  );

  // Tamper IV: flip the first hex character
  const tamperedIv = {
    ...encrypted,
    iv: (encrypted.iv[0] === "a" ? "b" : "a") + encrypted.iv.slice(1),
  };
  assert.throws(
    () => decryptRotationResult(tamperedIv, { key: validTestKeyHex }),
    /Decryption failed: ciphertext, IV, or authentication tag is invalid or tampered/,
    "Tampered IV must cause decryption to fail closed",
  );

  // Tamper authentication tag: flip the first hex character
  const tamperedTag = {
    ...encrypted,
    authTag: (encrypted.authTag[0] === "a" ? "b" : "a") + encrypted.authTag.slice(1),
  };
  assert.throws(
    () => decryptRotationResult(tamperedTag, { key: validTestKeyHex }),
    /Decryption failed: ciphertext, IV, or authentication tag is invalid or tampered/,
    "Tampered authentication tag must cause decryption to fail closed",
  );

  // Wrong key
  const differentKey = crypto.randomBytes(32).toString("hex");
  assert.throws(
    () => decryptRotationResult(encrypted, { key: differentKey }),
    /Decryption failed: ciphertext, IV, or authentication tag is invalid or tampered/,
    "Decryption with a different key must fail closed",
  );

  // Malformed non-hex or invalid length payloads
  assert.throws(
    () =>
      decryptRotationResult(
        { ...encrypted, authTag: "tooshort" },
        { key: validTestKeyHex },
      ),
    /Malformed encrypted rotation result/,
    "Short authTag must be rejected as malformed",
  );
  assert.throws(
    () =>
      decryptRotationResult(
        { ...encrypted, iv: "invalid-length" },
        { key: validTestKeyHex },
      ),
    /Malformed encrypted rotation result/,
    "Malformed IV must be rejected",
  );
  assert.throws(
    () =>
      decryptRotationResult(
        { ...encrypted, encryptedToken: "zzzznonhex!" },
        { key: validTestKeyHex },
      ),
    /Malformed encrypted rotation result/,
    "Non-hex ciphertext must be rejected",
  );
  console.log("✓ Tampered ciphertext, IV, authTag, and wrong keys all fail closed safely");

  // -------------------------------------------------------------
  // Test 5: Rejection of missing, invalid, or incorrectly sized keys
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing rejection of missing or incorrectly sized encryption keys...");

  // Key too short (32 hex characters = 16 bytes)
  assert.throws(
    () => validateRotationKey("0123456789abcdef0123456789abcdef"),
    /Invalid rotation encryption key: key must be a 64-character hexadecimal string representing a 256-bit key/,
    "128-bit key must be rejected",
  );

  // Key too long (128 hex characters)
  assert.throws(
    () => validateRotationKey("a".repeat(128)),
    /Invalid rotation encryption key/,
    "Oversized key must be rejected",
  );

  // Buffer key wrong length
  assert.throws(
    () => validateRotationKey(Buffer.alloc(16)),
    /key buffer must be exactly 32 bytes/,
    "16-byte Buffer key must be rejected",
  );

  // Key matching JWT_SECRET must be rejected
  if (env.JWT_SECRET) {
    // If JWT_SECRET is 64 hex chars or we test with matching value
    const jwtSecretCandidate = "a".repeat(64);
    const originalJwtSecret = env.JWT_SECRET;
    try {
      (env as { JWT_SECRET: string }).JWT_SECRET = jwtSecretCandidate;
      assert.throws(
        () => validateRotationKey(jwtSecretCandidate),
        /rotation key must be separate and distinct from JWT_SECRET/,
        "Key matching JWT_SECRET must be rejected",
      );
    } finally {
      (env as { JWT_SECRET: string }).JWT_SECRET = originalJwtSecret;
    }
  }

  // Fails closed if no key provided and env var not present
  const originalEnvKey = env.ROTATION_ENCRYPTION_KEY;
  try {
    delete (env as { ROTATION_ENCRYPTION_KEY?: string }).ROTATION_ENCRYPTION_KEY;
    assert.throws(
      () => validateRotationKey(undefined),
      /Rotation encryption key is not configured or provided/,
      "Missing key must fail closed",
    );
  } finally {
    (env as { ROTATION_ENCRYPTION_KEY?: string }).ROTATION_ENCRYPTION_KEY = originalEnvKey;
  }
  console.log("✓ Key validation strictly rejects missing, short, long, non-hex, and JWT-reused keys");

  // -------------------------------------------------------------
  // Test 6: RefreshToken Schema fields and index definitions
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing RefreshToken schema fields and index definitions...");
  const refreshPaths = RefreshToken.schema.paths;

  const expectedFields = [
    "userId",
    "tokenHash",
    "familyId",
    "clientType",
    "isRevoked",
    "revokedAt",
    "revokedReason",
    "replacedByTokenHash",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ];

  for (const field of expectedFields) {
    assert.ok(refreshPaths[field], `RefreshToken schema must contain field: ${field}`);
  }

  assert.deepEqual(
    CLIENT_TYPES,
    ["web", "vscode"],
    "Client types must support web and vscode",
  );

  const refreshIndexes = RefreshToken.schema.indexes();

  // Check unique tokenHash index
  const hasUniqueTokenHash = refreshIndexes.some(
    ([fields, opts]) => fields.tokenHash === 1 && opts?.unique === true,
  );
  assert.ok(hasUniqueTokenHash, "RefreshToken must have unique index on tokenHash");

  // Check familyId index
  const hasFamilyIdIndex = refreshIndexes.some(
    ([fields]) => fields.familyId === 1,
  );
  assert.ok(hasFamilyIdIndex, "RefreshToken must have index on familyId");

  // Check userId index
  const hasUserIdIndex = refreshIndexes.some(
    ([fields]) => fields.userId === 1,
  );
  assert.ok(hasUserIdIndex, "RefreshToken must have index on userId");

  // Check expiresAt TTL index
  const hasExpiresAtTtl = refreshIndexes.some(
    ([fields, opts]) => fields.expiresAt === 1 && opts?.expireAfterSeconds === 0,
  );
  assert.ok(hasExpiresAtTtl, "RefreshToken must have TTL index on expiresAt with expireAfterSeconds: 0");
  console.log("✓ RefreshToken schema fields and indexes correctly defined");

  // -------------------------------------------------------------
  // Test 7: RefreshTokenRotationCache schema and expiration metadata
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing RefreshTokenRotationCache schema and expiration metadata...");
  const cachePaths = RefreshTokenRotationCache.schema.paths;

  const expectedCacheFields = [
    "originalTokenHash",
    "encryptedSuccessorToken",
    "iv",
    "authTag",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ];

  for (const field of expectedCacheFields) {
    assert.ok(cachePaths[field], `RotationCache schema must contain field: ${field}`);
  }

  const cacheIndexes = RefreshTokenRotationCache.schema.indexes();

  const hasUniqueOriginalToken = cacheIndexes.some(
    ([fields, opts]) => fields.originalTokenHash === 1 && opts?.unique === true,
  );
  assert.ok(hasUniqueOriginalToken, "RotationCache must have unique lookup index on originalTokenHash");

  const hasCacheExpiresAtTtl = cacheIndexes.some(
    ([fields, opts]) => fields.expiresAt === 1 && opts?.expireAfterSeconds === 0,
  );
  assert.ok(hasCacheExpiresAtTtl, "RotationCache must have TTL index on expiresAt with expireAfterSeconds: 0");

  // Test expiration logic helper
  const now = Date.now();
  const pastDate = new Date(now - 5000);
  const futureDate = new Date(now + 60000);

  assert.equal(isRotationCacheExpired(pastDate), true, "Past date must report expired");
  assert.equal(isRotationCacheExpired(futureDate), false, "Future date must report not expired");
  assert.equal(isRotationCacheExpired("invalid-date"), true, "Invalid date fails closed as expired");
  console.log("✓ RefreshTokenRotationCache schema, indexes, and expiration logic verified");

  // -------------------------------------------------------------
  // Test 8: MongoDB Persistence & Index Constraint Verification
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing MongoDB persistence and unique index enforcement...");
  await connectDatabase();

  const createdUserIds: mongoose.Types.ObjectId[] = [];
  const createdTokenIds: mongoose.Types.ObjectId[] = [];
  const createdCacheIds: mongoose.Types.ObjectId[] = [];

  try {
    // Synchronize indexes in MongoDB
    await RefreshToken.syncIndexes();
    await RefreshTokenRotationCache.syncIndexes();

    // Create a dummy user
    const user = await User.create({
      name: "Refresh Token Tester",
      email: `refreshtest_${Date.now()}@example.com`,
    });
    createdUserIds.push(user._id);

    const rawToken = generateRefreshToken();
    const tokenHash = hashToken(rawToken);
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    // Persist refresh token record
    const refreshTokenDoc = await RefreshToken.create({
      userId: user._id,
      tokenHash,
      familyId,
      clientType: "web",
      isRevoked: false,
      expiresAt,
    });
    createdTokenIds.push(refreshTokenDoc._id);

    assert.equal(refreshTokenDoc.tokenHash, tokenHash, "Persisted tokenHash must match computed hash");
    // Verify raw token is NOT in the database document
    const rawDoc = refreshTokenDoc.toObject() as unknown as Record<string, unknown>;
    assert.equal(rawDoc.token, undefined, "Raw token must NEVER be persisted in document");
    assert.equal(rawDoc.refreshToken, undefined, "Raw token must NEVER be persisted in document");

    // Test unique index constraint on tokenHash
    let duplicateRejected = false;
    try {
      await RefreshToken.create({
        userId: user._id,
        tokenHash, // same tokenHash
        familyId: crypto.randomUUID(),
        clientType: "vscode",
        expiresAt,
      });
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 11000) {
        duplicateRejected = true;
      }
    }
    assert.ok(duplicateRejected, "Duplicate tokenHash must be rejected by MongoDB unique index");

    // Test query by familyId and userId
    const foundByFamily = await RefreshToken.find({ familyId });
    assert.equal(foundByFamily.length, 1, "Must query tokens by familyId");
    assert.equal(foundByFamily[0].userId.toString(), user._id.toString(), "Family token user must match");

    // Test RotationCache persistence
    const successorToken = generateRefreshToken();
    const encResult = encryptRotationResult(successorToken, { key: validTestKeyHex });
    const cacheExpiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds

    const cacheDoc = await RefreshTokenRotationCache.create({
      originalTokenHash: tokenHash,
      encryptedSuccessorToken: encResult.encryptedToken,
      iv: encResult.iv,
      authTag: encResult.authTag,
      expiresAt: cacheExpiresAt,
    });
    createdCacheIds.push(cacheDoc._id);

    assert.equal(cacheDoc.originalTokenHash, tokenHash);
    assert.equal(isRotationCacheExpired(cacheDoc.expiresAt), false);

    // Test unique index constraint on originalTokenHash in RotationCache
    let cacheDuplicateRejected = false;
    try {
      await RefreshTokenRotationCache.create({
        originalTokenHash: tokenHash, // same originalTokenHash
        encryptedSuccessorToken: encResult.encryptedToken,
        iv: encResult.iv,
        authTag: encResult.authTag,
        expiresAt: cacheExpiresAt,
      });
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 11000) {
        cacheDuplicateRejected = true;
      }
    }
    assert.ok(cacheDuplicateRejected, "Duplicate originalTokenHash in RotationCache must be rejected by MongoDB unique index");

    // Verify successor token decryption from persisted cache record
    const decryptedSuccessor = decryptRotationResult(
      {
        encryptedToken: cacheDoc.encryptedSuccessorToken,
        iv: cacheDoc.iv,
        authTag: cacheDoc.authTag,
      },
      { key: validTestKeyHex },
    );
    assert.equal(decryptedSuccessor, successorToken, "Decrypted successor token from database must match");
    console.log("✓ MongoDB persistence, unique constraints, and cryptographic roundtrip with database verified");
  } finally {
    // Cleanup created test records
    if (createdTokenIds.length > 0) {
      await RefreshToken.deleteMany({ _id: { $in: createdTokenIds } });
    }
    if (createdCacheIds.length > 0) {
      await RefreshTokenRotationCache.deleteMany({ _id: { $in: createdCacheIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await disconnectDatabase();
  }

  console.log("\n=========================================================================");
  console.log(" ALL 8 REFRESH TOKEN FOUNDATION & CRYPTOGRAPHIC TESTS PASSED (PHASE 2.1) ");
  console.log("=========================================================================");
};

runTests().catch((error) => {
  console.error("Test execution failed:", error);
  process.exit(1);
});
