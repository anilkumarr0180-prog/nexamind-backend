import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { OllamaProvider } from "../src/modules/ai/providers/ollama.provider.js";
import { AppError } from "../src/errors/app.error.js";
import { env } from "../src/config/env.js";

const runTests = async () => {
  console.log("=== Starting F05 Ollama Provider Timeout Test Suite ===");
  await connectDatabase();

  // -------------------------------------------------------------
  // Setup Mock Ollama Server
  // -------------------------------------------------------------
  // Creates a fast, deterministic local HTTP mock for Ollama API
  let hangingConnections: http.ServerResponse[] = [];

  const mockOllamaServer = http.createServer((req, res) => {
    if (req.url === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.messages?.[0]?.content?.includes("simulate_hang")) {
          // Keep connection open indefinitely without responding to simulate timeout
          hangingConnections.push(res);
        } else if (parsed.messages?.[0]?.content?.includes("simulate_error")) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal Ollama Crash" }));
        } else {
          // Fast successful response
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              model: "llama3.2:3b",
              message: {
                role: "assistant",
                content: "Mocked fast Ollama response",
              },
              done: true,
              prompt_eval_count: 8,
              eval_count: 16,
            }),
          );
        }
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  await new Promise<void>((resolve) => mockOllamaServer.listen(0, resolve));
  const mockPort = (mockOllamaServer.address() as any).port;
  const mockOllamaBaseUrl = `http://127.0.0.1:${mockPort}`;
  console.log(`Mock Ollama server running at ${mockOllamaBaseUrl}`);

  // Test server for live Express app
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`App server running at ${baseUrl}`);
  console.log(`Active OLLAMA_TIMEOUT_MS: ${env.OLLAMA_TIMEOUT_MS}ms`);

  const testTimestamp = Date.now();
  const testEmail = `timeout_test_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";
  let testUserId = "";
  let testToken = "";
  let testConvId = "";

  try {
    // -------------------------------------------------------------
    // Test 1: Ollama request succeeds before timeout
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing Ollama request succeeds before timeout...");
    const fastProvider = new OllamaProvider(mockOllamaBaseUrl, "llama3.2:3b", 500);
    const fastResponse = await fastProvider.generateChatResponse([
      { role: "user", content: "Hello fast Ollama" },
    ]);
    assert.equal(fastResponse.provider, "ollama");
    assert.equal(fastResponse.content, "Mocked fast Ollama response");
    assert.equal(fastResponse.usage.totalTokens, 24);
    console.log("✓ Fast Ollama request succeeded before timeout with valid response & tokens");

    // -------------------------------------------------------------
    // Test 2: Ollama request that exceeds timeout is aborted & produces 504 AI_PROVIDER_TIMEOUT
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing hanging Ollama request is aborted upon timeout...");
    // 50ms short timeout to verify immediate deterministic abort
    const timeoutProvider = new OllamaProvider(mockOllamaBaseUrl, "llama3.2:3b", 50);

    let caughtError: any = null;
    const startTime = Date.now();
    try {
      await timeoutProvider.generateChatResponse([
        { role: "user", content: "simulate_hang" },
      ]);
    } catch (err) {
      caughtError = err;
    }
    const elapsed = Date.now() - startTime;

    assert.ok(caughtError, "Hanging request must throw an error");
    assert.ok(caughtError instanceof AppError, "Thrown error must be an AppError");
    assert.equal(caughtError.statusCode, 504, "Timeout error must use HTTP status 504 Gateway Timeout");
    assert.equal(caughtError.code, "AI_PROVIDER_TIMEOUT", "Error code must be AI_PROVIDER_TIMEOUT");
    assert.equal(caughtError.message, "AI provider request timed out");
    assert.ok(elapsed < 1000, `Request should abort quickly (elapsed: ${elapsed}ms)`);
    console.log(`✓ Hanging request aborted after ${elapsed}ms and converted into controlled 504 AI_PROVIDER_TIMEOUT`);

    // -------------------------------------------------------------
    // Test 3: Non-timeout provider errors continue using 502 AI_PROVIDER_ERROR
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing non-timeout provider error produces 502 AI_PROVIDER_ERROR...");
    const errorProvider = new OllamaProvider(mockOllamaBaseUrl, "llama3.2:3b", 1000);
    let caughtNonTimeoutError: any = null;
    try {
      await errorProvider.generateChatResponse([
        { role: "user", content: "simulate_error" },
      ]);
    } catch (err) {
      caughtNonTimeoutError = err;
    }
    assert.ok(caughtNonTimeoutError instanceof AppError);
    assert.equal(caughtNonTimeoutError.statusCode, 502, "Non-timeout error must return 502");
    assert.equal(caughtNonTimeoutError.code, "AI_PROVIDER_ERROR", "Non-timeout error code must be AI_PROVIDER_ERROR");
    console.log("✓ Non-timeout provider error correctly returned 502 AI_PROVIDER_ERROR");

    // -------------------------------------------------------------
    // Test 4: End-to-End Orchestrator Compensation on Timeout
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing orchestrator credit refund and status compensation on timeout...");
    // Register test user
    const regResult = await authService.register({
      email: testEmail,
      password: testPassword,
    });
    testUserId = regResult.user.id;
    testToken = regResult.accessToken;

    const conv = await Conversation.create({
      userId: testUserId,
      title: "Timeout Compensation Test Conv",
    });
    testConvId = conv._id.toString();

    // Set orchestrator to use the timeout provider (50ms timeout against hanging mock)
    orchestratorService.setDefaultProvider(timeoutProvider);

    const initialBalance = (await tokenService.getBalance(testUserId)).balance;
    const initialAssistantCount = await Message.countDocuments({
      conversationId: testConvId,
      role: MESSAGE_ROLES.ASSISTANT,
    });

    // Make live API call to POST /api/v1/ai/chat
    const apiRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testToken}`,
      },
      body: JSON.stringify({
        conversationId: testConvId,
        content: "simulate_hang - this will time out",
      }),
    });

    assert.equal(apiRes.status, 504, "API endpoint must return 504 Gateway Timeout");
    const apiJson = await apiRes.json();
    assert.equal(apiJson.success, false);
    assert.equal(apiJson.error.code, "AI_PROVIDER_TIMEOUT");
    assert.equal(apiJson.error.message, "AI provider request timed out");

    // Verify raw AbortError / internal URL / stack traces are NOT leaked
    const jsonStr = JSON.stringify(apiJson);
    assert.ok(!jsonStr.includes("AbortError"), "Raw AbortError must not be exposed");
    assert.ok(!jsonStr.includes("TimeoutError"), "Raw TimeoutError must not be exposed");
    assert.ok(!jsonStr.includes("http://"), "Internal URLs must not be exposed");
    assert.ok(!jsonStr.includes("stack"), "Stack trace must not be exposed");
    console.log("✓ API returned clean 504 AI_PROVIDER_TIMEOUT without leaking internal/network details");

    // Verify credit compensation: balance must be fully refunded
    const finalBalance = (await tokenService.getBalance(testUserId)).balance;
    assert.equal(finalBalance, initialBalance, "User credit must be refunded upon timeout");
    console.log(`✓ Credit balance refunded and preserved (Balance: ${finalBalance})`);

    // Verify user message status is FAILED
    const failedUserMessage = await Message.findOne({
      conversationId: testConvId,
      role: MESSAGE_ROLES.USER,
    });
    assert.ok(failedUserMessage, "User message must be persisted");
    assert.equal(
      failedUserMessage.status,
      MESSAGE_STATUSES.FAILED,
      "Persisted user message status must be FAILED after timeout",
    );
    console.log("✓ User message status marked as FAILED");

    // Verify no assistant message was created
    const finalAssistantCount = await Message.countDocuments({
      conversationId: testConvId,
      role: MESSAGE_ROLES.ASSISTANT,
    });
    assert.equal(
      finalAssistantCount,
      initialAssistantCount,
      "No assistant message must be created upon timeout",
    );
    console.log("✓ No assistant message was created in the database");

    // -------------------------------------------------------------
    // Test 5: Normal AI Chat succeeds through live app when provider is responsive
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing normal AI chat succeeds through live app when responsive...");
    orchestratorService.setDefaultProvider(fastProvider);

    const successRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testToken}`,
      },
      body: JSON.stringify({
        conversationId: testConvId,
        content: "Hello working Ollama",
      }),
    });

    assert.equal(successRes.status, 200, "Responsive provider must return 200");
    const successJson = await successRes.json();
    assert.equal(successJson.success, true);
    assert.equal(successJson.data.assistantMessage.content, "Mocked fast Ollama response");
    console.log("✓ Normal AI chat succeeded through live app with responsive provider");

    console.log("\n==================================================");
    console.log(" ALL F05 OLLAMA TIMEOUT TESTS PASSED SUCCESSFULLY ");
    console.log("==================================================");
  } finally {
    // Clean up hanging connections
    hangingConnections.forEach((res) => {
      try {
        res.destroy();
      } catch {}
    });

    // Clean up test data
    try {
      if (testUserId) {
        await TokenBalance.deleteMany({ userId: testUserId });
        await Message.deleteMany({ userId: testUserId });
        await Conversation.deleteMany({ userId: testUserId });
        await User.deleteMany({ _id: testUserId });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }

    mockOllamaServer.close();
    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Ollama Timeout Test Suite Failed:", err);
  process.exit(1);
});
