import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import {
  AgentService,
  agentService,
  setAgentService,
  AGENT_STATUSES,
  TOOL_CALL_STATUSES,
  ToolRegistry,
  calculatorTool,
} from "../src/modules/agent/index.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

/**
 * Controllable Mock AI Provider for API testing
 */
class MockAIProvider implements AIProvider {
  public readonly name = "mock_api_provider";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];
  private readonly handler: (
    messages: AIMessage[],
    options?: ChatResponseOptions,
    callIndex: number,
  ) => Promise<AIResponse> | AIResponse;

  constructor(
    handler: (
      messages: AIMessage[],
      options?: ChatResponseOptions,
      callIndex: number,
    ) => Promise<AIResponse> | AIResponse,
  ) {
    this.handler = handler;
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
    return this.handler(messages, options, callIndex);
  }
}

const runTests = async () => {
  console.log("=== Starting Agent Core: Agent API Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  const testId = Date.now();
  const testEmail = `agent_api_user_${testId}@example.com`;
  const testPassword = "Password123!@#$";

  let userId = "";
  let userToken = "";

  try {
    // 1. Setup authenticated user
    const regResult = await authService.register({
      email: testEmail,
      password: testPassword,
    });
    userId = regResult.user.id;
    userToken = regResult.accessToken;
    console.log(`✓ Created test user ${userId}`);

    // -------------------------------------------------------------
    // Test 1: Unauthenticated request rejected with 401
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing unauthenticated request...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "Autonomous task" }),
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.error.code, "UNAUTHORIZED");

      // Also test with invalid Bearer token
      const resInvalid = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid.token.value",
        },
        body: JSON.stringify({ task: "Autonomous task" }),
      });
      assert.equal(resInvalid.status, 401);
      const jsonInvalid = await resInvalid.json();
      assert.equal(jsonInvalid.success, false);
      assert.equal(jsonInvalid.error.code, "UNAUTHORIZED");
      console.log("✓ Unauthenticated and invalid token requests rejected with 401 UNAUTHORIZED");
    }

    // -------------------------------------------------------------
    // Test 2: Missing task field rejected with 400
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing missing task field...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.error.code, "VALIDATION_ERROR");
      console.log("✓ Missing task field rejected with 400 VALIDATION_ERROR");
    }

    // -------------------------------------------------------------
    // Test 3: Empty and whitespace-only task rejected with 400
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing empty and whitespace-only task...");
    {
      // Empty string
      const resEmpty = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "" }),
      });
      assert.equal(resEmpty.status, 400);
      const jsonEmpty = await resEmpty.json();
      assert.equal(jsonEmpty.error.code, "VALIDATION_ERROR");

      // Whitespace only
      const resWhitespace = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "   \t  \n " }),
      });
      assert.equal(resWhitespace.status, 400);
      const jsonWhitespace = await resWhitespace.json();
      assert.equal(jsonWhitespace.error.code, "VALIDATION_ERROR");

      // Non-string task
      const resNonString = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: 12345 }),
      });
      assert.equal(resNonString.status, 400);
      const jsonNonString = await resNonString.json();
      assert.equal(jsonNonString.error.code, "VALIDATION_ERROR");

      console.log("✓ Empty, whitespace-only, and non-string tasks rejected with 400 VALIDATION_ERROR");
    }

    // -------------------------------------------------------------
    // Test 4: Invalid maxSteps rejected with 400
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing invalid maxSteps boundary and type validation...");
    {
      const badSteps = [0, -1, 26, 100, 3.14, "ten", true];
      for (const stepVal of badSteps) {
        const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ task: "Analyze system logs", maxSteps: stepVal }),
        });
        assert.equal(res.status, 400, `maxSteps=${stepVal} must be rejected with 400`);
        const json = await res.json();
        assert.equal(json.error.code, "VALIDATION_ERROR");
      }
      console.log("✓ Invalid maxSteps (<1, >25, non-integer, string) strictly rejected with 400");
    }

    // -------------------------------------------------------------
    // Test 5: Client cannot supply or override userId
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing userId cannot be supplied or overridden by client...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          task: "Run data query",
          userId: "malicious_spoofed_user_id",
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.error.code, "VALIDATION_ERROR");
      console.log("✓ Client submission of userId strictly rejected with 400 VALIDATION_ERROR (.strict schema)");
    }

    // -------------------------------------------------------------
    // Test 6: Authenticated valid request & successful execution
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing authenticated valid request and successful execution...");
    {
      const mockProvider = new MockAIProvider(async () => ({
        content: "Task execution finished with high accuracy.",
        provider: "mock-provider",
        model: "mock-model",
        usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
      }));

      setAgentService(new AgentService({ provider: mockProvider }));

      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          task: "Summarize cluster metrics",
          conversationId: "conv_audit_100",
          systemPrompt: "You are a cloud diagnostics agent.",
          maxSteps: 5,
          context: { cluster: "prod-us-east-1", nodeCount: 12 },
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data);

      const result = json.data;
      assert.equal(result.status, AGENT_STATUSES.COMPLETED);
      assert.equal(result.output, "Task execution finished with high accuracy.");
      assert.equal(result.userId, userId, "userId must be derived from authenticated user context");
      assert.equal(result.task, "Summarize cluster metrics");
      assert.equal(result.conversationId, "conv_audit_100");
      assert.equal(result.stepsCompleted, 1);
      assert.ok(result.executionId);
      assert.ok(result.startedAt);
      assert.ok(result.completedAt);
      assert.ok(result.durationMs >= 0);
      assert.equal(result.usage.totalTokens, 50);
      console.log("✓ Authenticated valid request returned 200 OK and valid AgentExecutionResult");
    }

    // -------------------------------------------------------------
    // Test 7: Controlled agent failure returns 200 with status FAILED
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing controlled agent failure...");
    {
      const failingProvider = new MockAIProvider(async () => {
        throw new Error("Upstream LLM rate limit (429) encountered");
      });

      setAgentService(new AgentService({ provider: failingProvider }));

      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Perform heavy analysis" }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      const result = json.data;
      assert.equal(result.status, AGENT_STATUSES.FAILED);
      assert.equal(result.output, null);
      assert.equal(result.error, "Upstream LLM rate limit (429) encountered");
      assert.equal(result.userId, userId);
      assert.ok(result.executionId);
      assert.ok(result.durationMs >= 0);

      // Verify no stack trace or secrets leaked
      assert.equal(json.stack, undefined);
      assert.equal(json.error, undefined);
      console.log("✓ Controlled agent failure cleanly captured and returned with status FAILED");
    }

    // -------------------------------------------------------------
    // Test 8: Tool execution integration via API
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing full tool execution cycle through Agent API...");
    {
      const registry = new ToolRegistry();
      registry.register(calculatorTool);

      const toolProvider = new MockAIProvider(async (_msgs, _opts, callIndex) => {
        if (callIndex === 0) {
          return {
            content: "Let me compute this for you.",
            provider: "mock",
            model: "mock-model",
            toolCalls: [
              {
                id: "call_calc_1",
                name: "calculator",
                arguments: { expression: "25 * 4 + 7" },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
          };
        }
        return {
          content: "The final answer is 107.",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        };
      });

      setAgentService(new AgentService({ provider: toolProvider, registry }));

      const res = await fetch(`${baseUrl}/api/v1/agent/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Calculate 25 * 4 + 7" }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      const result = json.data;

      assert.equal(result.status, AGENT_STATUSES.COMPLETED);
      assert.equal(result.output, "The final answer is 107.");
      assert.equal(result.stepsCompleted, 2);
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].name, "calculator");
      assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.SUCCESS);
      assert.deepEqual(result.toolCalls[0].result, { expression: "25 * 4 + 7", result: 107 });
      assert.equal(result.usage.totalTokens, 55);
      console.log("✓ Full tool execution cycle completed through HTTP endpoint with 200 OK");
    }

    console.log("\n==================================================");
    console.log(" ALL AGENT API TESTS PASSED SUCCESSFULLY ");
    console.log("==================================================");
  } finally {
    // Reset agent service to default singleton
    setAgentService(agentService);

    // Teardown test user and token balance
    if (userId) {
      await TokenBalance.deleteMany({ userId });
      await User.deleteMany({ _id: userId });
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Agent API Test Suite Failed:", err);
  process.exit(1);
});
