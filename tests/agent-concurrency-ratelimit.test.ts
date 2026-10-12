import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose, { Types } from "mongoose";
import app from "../src/app.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { CreditTransaction } from "../src/modules/credit-transactions/credit-transaction.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import {
  AgentService,
  setAgentService,
  agentService,
  AGENT_STATUSES,
} from "../src/modules/agent/index.js";
import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentRunOptions,
} from "../src/modules/agent/agent.types.js";
import { resetAiRateLimit } from "../src/middleware/rate-limit.js";
import { resolveDedicatedTestDbUri } from "../load-tests/config.ts";
import { AppError } from "../src/errors/app.error.js";
import { env } from "../src/config/env.js";

/**
 * Controllable Mock Agent Service to test concurrency, locking, and cancellation
 */
class ControllableMockAgentService extends AgentService {
  public executionDelayMs: number = 0;
  public shouldFail: boolean = false;
  public failError: Error = new AppError("Simulated agent failure", 500, "AGENT_ERROR");
  public executionCount: number = 0;
  public wasCancelled: boolean = false;

  constructor() {
    super();
  }

  async execute(
    input: AgentExecutionInput,
    runOptions?: AgentRunOptions,
  ): Promise<AgentExecutionResult> {
    this.executionCount++;

    if (this.executionDelayMs > 0) {
      const start = Date.now();
      while (Date.now() - start < this.executionDelayMs) {
        if (runOptions?.signal?.aborted) {
          this.wasCancelled = true;
          return {
            task: input.task,
            status: AGENT_STATUSES.CANCELLED,
            output: null,
            steps: [],
            totalSteps: 0,
            durationMs: Date.now() - start,
          };
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    if (runOptions?.signal?.aborted) {
      this.wasCancelled = true;
      return {
        task: input.task,
        status: AGENT_STATUSES.CANCELLED,
        output: null,
        steps: [],
        totalSteps: 0,
        durationMs: 0,
      };
    }

    if (this.shouldFail) {
      throw this.failError;
    }

    runOptions?.callbacks?.onStart?.({
      conversationId: input.conversationId || "test-conv",
    });
    runOptions?.callbacks?.onChunk?.("Mock agent chunk");

    return {
      task: input.task,
      status: AGENT_STATUSES.COMPLETED,
      output: "Mock agent completed output",
      steps: [],
      totalSteps: 1,
      durationMs: 50,
    };
  }

  async executeStream(
    input: AgentExecutionInput,
    callbacks: any,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    return this.execute(input, { callbacks, signal });
  }
}

const createdUserIds: string[] = [];

async function runAgentConcurrencyAndRateLimitTests(): Promise<void> {
  console.log("\n==========================================================================");
  console.log("=== NEXAMIND AGENT RATE LIMITING & DUPLICATE PROTECTION VERIFICATION ===");
  console.log("==========================================================================");

  const testDbUri = resolveDedicatedTestDbUri();
  console.log(`[Setup] Connecting to isolated test database...`);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(testDbUri);
  }

  const mockService = new ControllableMockAgentService();
  setAgentService(mockService);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Setup] Test server running at ${baseUrl}\n`);

  try {
    const timestamp = Date.now();
    const userA = await authService.register({
      email: `agent_conc_a_${timestamp}@test.local`,
      password: "Password123!@#$",
    });
    createdUserIds.push(userA.user.id);

    const userB = await authService.register({
      email: `agent_conc_b_${timestamp}@test.local`,
      password: "Password123!@#$",
    });
    createdUserIds.push(userB.user.id);

    const convA1 = await conversationService.createConversation(userA.user.id, {
      title: "Agent Concurrency Conversation 1",
    });

    const convA2 = await conversationService.createConversation(userA.user.id, {
      title: "Agent Concurrency Conversation 2",
    });

    // -------------------------------------------------------------------------
    // TEST 1: RATE LIMITING ON ALL AGENT ENDPOINTS
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 1: RATE LIMITING] Testing aiRateLimiter active on every Agent endpoint...");
    console.log("--------------------------------------------------------------------------");
    {
      await resetAiRateLimit();

      const endpoints = [
        "/api/v1/agent/execute",
        "/api/v1/agent/run",
        "/api/v1/agent/stream",
        "/api/v1/agent/run/stream",
      ];

      for (const endpoint of endpoints) {
        const res = await fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userA.accessToken}`,
          },
          body: JSON.stringify({
            task: "Verify rate limiter headers",
          }),
        });

        assert.strictEqual(
          res.status,
          200,
          `Endpoint ${endpoint} should succeed below limit`,
        );

        // Verify standard express-rate-limit headers
        const limitHeader = res.headers.get("ratelimit-limit");
        const remainingHeader = res.headers.get("ratelimit-remaining");
        const resetHeader = res.headers.get("ratelimit-reset");

        assert.ok(
          limitHeader !== null,
          `Endpoint ${endpoint} must include RateLimit-Limit header`,
        );
        assert.ok(
          remainingHeader !== null,
          `Endpoint ${endpoint} must include RateLimit-Remaining header`,
        );
        assert.ok(
          resetHeader !== null,
          `Endpoint ${endpoint} must include RateLimit-Reset header`,
        );

        console.log(`✓ Endpoint ${endpoint} verified with RateLimit headers (Limit: ${limitHeader}, Remaining: ${remainingHeader})`);
      }

      await resetAiRateLimit();
      console.log("✓ Test 1 Passed: Rate limiting active across all Agent endpoints\n");
    }

    // -------------------------------------------------------------------------
    // TEST 2: DUPLICATE SAME-CONVERSATION EXECUTION REJECTED (409 GENERATION_IN_PROGRESS)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 2: DUPLICATE REJECTION] Testing 409 GENERATION_IN_PROGRESS on conflict...");
    console.log("--------------------------------------------------------------------------");
    {
      orchestratorService.clearActiveGenerations();
      // Configure mock service to take 400ms to allow overlapping request
      mockService.executionDelayMs = 400;
      mockService.shouldFail = false;

      const req1Promise = fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Long running agent task 1",
          conversationId: convA1._id.toString(),
        }),
      });

      // Small delay to ensure req1 has acquired the lock
      await new Promise((r) => setTimeout(r, 60));

      const req2Promise = fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Conflicting agent task 2 in same conversation",
          conversationId: convA1._id.toString(),
        }),
      });

      const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

      assert.strictEqual(res1.status, 200, "First execution should succeed");
      assert.strictEqual(
        res2.status,
        409,
        "Conflicting simultaneous execution must be rejected with 409",
      );

      const json2 = await res2.json();
      assert.strictEqual(json2.success, false);
      assert.strictEqual(
        json2.error.code,
        "GENERATION_IN_PROGRESS",
        "Error code must be GENERATION_IN_PROGRESS",
      );

      mockService.executionDelayMs = 0;
      console.log("✓ Test 2 Passed: Simultaneous execution in same conversation returned 409 GENERATION_IN_PROGRESS\n");
    }

    // -------------------------------------------------------------------------
    // TEST 3: DIFFERENT CONVERSATIONS REMAIN INDEPENDENT
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 3: CONVERSATION INDEPENDENCE] Testing different conversations run in parallel...");
    console.log("--------------------------------------------------------------------------");
    {
      orchestratorService.clearActiveGenerations();
      mockService.executionDelayMs = 200;

      const [resA1, resA2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/agent/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userA.accessToken}`,
          },
          body: JSON.stringify({
            task: "Task in conversation A1",
            conversationId: convA1._id.toString(),
          }),
        }),
        fetch(`${baseUrl}/api/v1/agent/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userA.accessToken}`,
          },
          body: JSON.stringify({
            task: "Parallel task in conversation A2",
            conversationId: convA2._id.toString(),
          }),
        }),
      ]);

      assert.strictEqual(resA1.status, 200, "Conversation A1 should succeed");
      assert.strictEqual(resA2.status, 200, "Conversation A2 should succeed");
      mockService.executionDelayMs = 0;
      console.log("✓ Test 3 Passed: Independent conversations executed concurrently without conflict\n");
    }

    // -------------------------------------------------------------------------
    // TEST 4: LOCK RELEASED AFTER SUCCESS AND FAILURE
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 4: LOCK RELEASE] Testing lock is released after success and failure...");
    console.log("--------------------------------------------------------------------------");
    {
      // 4a. Success release
      mockService.executionDelayMs = 50;
      mockService.shouldFail = false;

      const resSuccess = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Sequential task 1",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(resSuccess.status, 200);

      assert.strictEqual(
        orchestratorService.isGenerationActiveForConversation(convA1._id.toString()),
        false,
        "Lock must be released after successful completion",
      );

      // Subsequent execution immediately succeeds
      const resAfterSuccess = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Sequential task 2 immediately after",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(resAfterSuccess.status, 200, "Subsequent execution after success must succeed");
      console.log("✓ Test 4a Passed: Lock released on success; subsequent execution succeeded");

      // 4b. Failure release
      mockService.shouldFail = true;
      const resFailure = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Failing task",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(resFailure.status, 500);

      assert.strictEqual(
        orchestratorService.isGenerationActiveForConversation(convA1._id.toString()),
        false,
        "Lock must be released even after execution throws error",
      );

      mockService.shouldFail = false;
      const resAfterFailure = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Recovery task after failure",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(resAfterFailure.status, 200, "Subsequent execution after failure must succeed");
      console.log("✓ Test 4b Passed: Lock released on failure; recovery execution succeeded\n");
    }

    // -------------------------------------------------------------------------
    // TEST 5: CLIENT CANCELLATION RELEASES PROTECTION
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 5: CANCELLATION] Testing client abort/disconnect releases lock...");
    console.log("--------------------------------------------------------------------------");
    {
      mockService.executionDelayMs = 250;
      mockService.wasCancelled = false;

      const postData = JSON.stringify({
        task: "Streaming task to abort mid-flight",
        conversationId: convA1._id.toString(),
      });

      await new Promise<void>((resolve) => {
        const clientReq = http.request(
          `${baseUrl}/api/v1/agent/stream`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              Authorization: `Bearer ${userA.accessToken}`,
              "Content-Length": Buffer.byteLength(postData),
            },
          },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            res.on("data", (chunk: Buffer) => {
              const str = chunk.toString();
              if (str.includes("start") || str.includes("chunk")) {
                // Client disconnects socket immediately while agent is running
                clientReq.destroy();
                setTimeout(resolve, 150);
              }
            });
          },
        );

        clientReq.on("error", () => {
          setTimeout(resolve, 150);
        });

        clientReq.write(postData);
        clientReq.end();
      });

      // Assert lock was released in finally block
      assert.strictEqual(
        orchestratorService.isGenerationActiveForConversation(convA1._id.toString()),
        false,
        "Lock must be released following client cancellation",
      );

      mockService.executionDelayMs = 0;

      // New request in conversation A1 must succeed immediately
      const resPostAbort = await fetch(`${baseUrl}/api/v1/agent/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "New streaming task after abort",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(resPostAbort.status, 200);
      console.log("✓ Test 5 Passed: Client cancellation safely released lock; new request succeeded\n");
    }

    // -------------------------------------------------------------------------
    // TEST 6: CREDITS ARE NOT DEDUCTED TWICE
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------");
    console.log("[Test 6: CREDIT DEDUCTION INTEGRITY] Testing no double deduction on 409 or retry...");
    console.log("--------------------------------------------------------------------------");
    {
      const initialBalance = await tokenService.getBalance(userA.user.id);

      // 6a. Conflicting 409 request does not deduct credits
      mockService.executionDelayMs = 300;
      const req1 = fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Task holding lock",
          conversationId: convA2._id.toString(),
        }),
      });

      await new Promise((r) => setTimeout(r, 60));

      const req2 = fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
        },
        body: JSON.stringify({
          task: "Conflicting task that gets 409",
          conversationId: convA2._id.toString(),
        }),
      });

      const [res1, res2] = await Promise.all([req1, req2]);
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 409);

      const balanceAfterConflict = await tokenService.getBalance(userA.user.id);
      // Only req1 should have deducted exactly 1 credit; req2 was rejected before deduction
      assert.strictEqual(
        balanceAfterConflict.balance,
        initialBalance.balance - 1,
        "Conflicting 409 request must NOT deduct credits",
      );
      console.log(`✓ Test 6a Passed: Balance changed from ${initialBalance.balance} to ${balanceAfterConflict.balance} (exactly 1 deduction, 0 for 409 rejection)`);

      mockService.executionDelayMs = 0;

      // 6b. Idempotency Key Retry does not deduct credits twice
      const idempotencyKey = `agent-idem-test-${Date.now()}`;
      const balanceBeforeIdem = await tokenService.getBalance(userA.user.id);

      const idemRes1 = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          task: "Idempotent task call 1",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(idemRes1.status, 200);

      const balanceAfterIdem1 = await tokenService.getBalance(userA.user.id);
      assert.strictEqual(balanceAfterIdem1.balance, balanceBeforeIdem.balance - 1);

      // Retry with the exact same idempotency key
      const idemRes2 = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA.accessToken}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          task: "Idempotent task retry with same key",
          conversationId: convA1._id.toString(),
        }),
      });
      assert.strictEqual(idemRes2.status, 200);

      const balanceAfterIdem2 = await tokenService.getBalance(userA.user.id);
      assert.strictEqual(
        balanceAfterIdem2.balance,
        balanceAfterIdem1.balance,
        "Retrying with the same idempotency key must NOT deduct credits a second time",
      );
      console.log(`✓ Test 6b Passed: Idempotent retry preserved credit balance (${balanceAfterIdem2.balance}) without double deduction\n`);
    }

    console.log("==========================================================================");
    console.log("=== ALL AGENT RATE LIMIT & DUPLICATE PROTECTION TESTS PASSED (6/6) ===");
    console.log("==========================================================================\n");
  } finally {
    setAgentService(agentService);
    server.close();
    if (createdUserIds.length > 0) {
      const oids = createdUserIds.map((id) => new Types.ObjectId(id));
      await Promise.all([
        User.deleteMany({ _id: { $in: oids } }),
        Conversation.deleteMany({ userId: { $in: oids } }),
        Message.deleteMany({ userId: { $in: oids } }),
        TokenBalance.deleteMany({ userId: { $in: oids } }),
        CreditTransaction.deleteMany({ userId: { $in: oids } }),
      ]);
    }
    await mongoose.disconnect();
  }
}

runAgentConcurrencyAndRateLimitTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
