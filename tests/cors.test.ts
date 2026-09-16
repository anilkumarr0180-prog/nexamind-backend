import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import cors from "cors";
import app from "../src/app.js";
import { env } from "../src/config/env.js";

const runTests = async () => {
  console.log("=== Starting F04 CORS Hardening Test Suite ===");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);
  console.log(`Active CORS_ORIGINS allowlist:`, env.CORS_ORIGINS);

  try {
    const configuredOrigin = env.CORS_ORIGINS[0] || "http://localhost:5173";
    const unconfiguredOrigin = "http://malicious-site.example.com";

    // -------------------------------------------------------------
    // Test 1: Configured frontend origin receives CORS approval headers
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing request from configured frontend origin...");
    const allowedRes = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: configuredOrigin,
      },
    });
    assert.equal(allowedRes.status, 200, "Configured origin GET should return 200");
    const allowedOriginHeader = allowedRes.headers.get("access-control-allow-origin");
    const allowedCredentialsHeader = allowedRes.headers.get("access-control-allow-credentials");
    assert.equal(
      allowedOriginHeader,
      configuredOrigin,
      `Access-Control-Allow-Origin must match configured origin (${configuredOrigin})`
    );
    assert.equal(
      allowedCredentialsHeader,
      "true",
      "Access-Control-Allow-Credentials must be 'true'"
    );
    console.log(`✓ Configured origin (${configuredOrigin}) received Access-Control-Allow-Origin and credentials approval`);

    // -------------------------------------------------------------
    // Test 2: Unconfigured browser origin does NOT receive Access-Control-Allow-Origin
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing request from unconfigured browser origin...");
    const rejectedRes = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: unconfiguredOrigin,
      },
    });
    assert.equal(rejectedRes.status, 200, "Route still executes for unconfigured origin");
    const rejectedOriginHeader = rejectedRes.headers.get("access-control-allow-origin");
    assert.equal(
      rejectedOriginHeader,
      null,
      "Unconfigured origin must NOT receive Access-Control-Allow-Origin header"
    );
    console.log("✓ Unconfigured origin did NOT receive Access-Control-Allow-Origin");

    // -------------------------------------------------------------
    // Test 3: Preflight (OPTIONS) request from configured origin
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing preflight (OPTIONS) request from configured origin...");
    const preflightAllowedRes = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: configuredOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });
    assert.equal(preflightAllowedRes.status, 204, "Preflight should return 204 No Content");
    assert.equal(
      preflightAllowedRes.headers.get("access-control-allow-origin"),
      configuredOrigin,
      "Preflight must return configured origin in Access-Control-Allow-Origin"
    );
    assert.equal(
      preflightAllowedRes.headers.get("access-control-allow-credentials"),
      "true",
      "Preflight must return Access-Control-Allow-Credentials: true"
    );
    const allowMethods = preflightAllowedRes.headers.get("access-control-allow-methods");
    assert.ok(allowMethods?.includes("POST"), "Preflight must allow POST method");
    console.log("✓ Preflight for configured origin returned 204 with correct CORS headers");

    // -------------------------------------------------------------
    // Test 4: Preflight (OPTIONS) request from unconfigured origin
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing preflight (OPTIONS) request from unconfigured origin...");
    const preflightRejectedRes = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: unconfiguredOrigin,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(
      preflightRejectedRes.headers.get("access-control-allow-origin"),
      null,
      "Preflight for unconfigured origin must NOT return Access-Control-Allow-Origin"
    );
    console.log("✓ Preflight for unconfigured origin did NOT receive Access-Control-Allow-Origin");

    // -------------------------------------------------------------
    // Test 5: Requests without Origin header (Postman / curl / server-to-server)
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing non-browser request without Origin header (curl / Postman)...");
    const noOriginRes = await fetch(`${baseUrl}/health`);
    assert.equal(noOriginRes.status, 200, "Request without Origin header must return 200");
    const body = await noOriginRes.json();
    assert.equal(body.success, true, "Response body should be valid");
    assert.equal(body.message, "NexaMind API is healthy");
    assert.equal(
      noOriginRes.headers.get("access-control-allow-origin"),
      null,
      "Request without Origin header should not receive Access-Control-Allow-Origin"
    );
    console.log("✓ Non-browser request without Origin header executed successfully with 200 OK");

    // -------------------------------------------------------------
    // Test 6: Attacker spoofing attempts (subdomain, suffix, null origin)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing attacker spoofing attempts...");
    const attackOrigins = [
      `${configuredOrigin}.attacker.com`,
      `http://attacker.com/${configuredOrigin}`,
      `http://attacker-${configuredOrigin.replace("http://", "")}`,
      "null",
    ];

    for (const attackOrigin of attackOrigins) {
      const attackRes = await fetch(`${baseUrl}/health`, {
        headers: { Origin: attackOrigin },
      });
      assert.equal(
        attackRes.headers.get("access-control-allow-origin"),
        null,
        `Spoofed origin '${attackOrigin}' must NOT receive Access-Control-Allow-Origin`
      );
    }
    console.log("✓ All origin spoofing attempts rejected without Access-Control-Allow-Origin");

    // -------------------------------------------------------------
    // Test 7: Authenticated API endpoint with CORS
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing API endpoints with CORS headers...");
    const apiAllowedRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Origin: configuredOrigin },
    });
    // Unauthenticated request returns 401, but CORS headers must be present for allowed origin
    assert.equal(apiAllowedRes.status, 401);
    assert.equal(
      apiAllowedRes.headers.get("access-control-allow-origin"),
      configuredOrigin,
      "API error response must still have Access-Control-Allow-Origin for allowed origin"
    );

    const apiRejectedRes = await fetch(`${baseUrl}/api/v1/tokens/balance`, {
      headers: { Origin: unconfiguredOrigin },
    });
    assert.equal(apiRejectedRes.status, 401);
    assert.equal(
      apiRejectedRes.headers.get("access-control-allow-origin"),
      null,
      "API error response must NOT have Access-Control-Allow-Origin for unconfigured origin"
    );
    console.log("✓ API endpoints properly attach CORS headers for configured origins and omit for unconfigured");

    // -------------------------------------------------------------
    // Test 8: Multiple comma-separated origins support
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing multi-origin allowlist support...");
    const multiOriginApp = express();
    const allowedList = ["http://localhost:5173", "http://localhost:3000", "https://app.nexamind.ai"];
    multiOriginApp.use(
      cors({
        origin: allowedList,
        credentials: true,
      })
    );
    multiOriginApp.get("/test", (_req, res) => res.json({ ok: true }));

    const multiServer = http.createServer(multiOriginApp);
    await new Promise<void>((resolve) => multiServer.listen(0, resolve));
    const multiPort = (multiServer.address() as any).port;
    const multiBaseUrl = `http://127.0.0.1:${multiPort}`;

    try {
      for (const origin of allowedList) {
        const res = await fetch(`${multiBaseUrl}/test`, {
          headers: { Origin: origin },
        });
        assert.equal(
          res.headers.get("access-control-allow-origin"),
          origin,
          `Multi-origin app must allow '${origin}'`
        );
      }

      const resBlocked = await fetch(`${multiBaseUrl}/test`, {
        headers: { Origin: "http://localhost:9999" },
      });
      assert.equal(
        resBlocked.headers.get("access-control-allow-origin"),
        null,
        "Unlisted origin must not receive Access-Control-Allow-Origin in multi-origin setup"
      );
      console.log("✓ Multi-origin allowlist verified across all configured origins");
    } finally {
      multiServer.close();
    }

    console.log("\n==================================================");
    console.log(" ALL F04 CORS HARDENING TESTS PASSED SUCCESSFULLY ");
    console.log("==================================================");
  } finally {
    server.close();
  }
};

runTests().catch((err) => {
  console.error("CORS Test Suite Failed:", err);
  process.exit(1);
});
