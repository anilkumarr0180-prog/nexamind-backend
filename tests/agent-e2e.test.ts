import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
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
 * Controllable Mock AI Provider for end-to-end testing
 */
class ControllableMockAIProvider implements AIProvider {
  public readonly name = "mock_e2e_provider";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];
  private handler: (
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

  public setHandler(
    handler: (
      messages: AIMessage[],
      options?: ChatResponseOptions,
      callIndex: number,
    ) => Promise<AIResponse> | AIResponse,
  ): void {
    this.handler = handler;
    this.calls = [];
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
  console.log("=== Starting NexaMind Agent Core: Step 10 End-to-End Verification ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`E2E Test server active at ${baseUrl}`);

  const testId = Date.now();
  const testEmail = `agent_e2e_user_${testId}@example.com`;
  const testPassword = "Password123!@#$";

  let userId = "";
  let userToken = "";
  let conversationId = "";

  // Shared mock provider
  const mockAI = new ControllableMockAIProvider(async () => ({
    content: "Default mock response.",
    provider: "mock",
    model: "mock-model",
  }));

  const initialChatProvider = orchestratorService.getDefaultProvider();

  try {
    // Setup authenticated user
    const regResult = await authService.register({
      email: testEmail,
      password: testPassword,
    });
    userId = regResult.user.id;
    userToken = regResult.accessToken;

    const convResult = await conversationService.createConversation(userId, {
      title: "Agent Verification Conversation",
    });
    conversationId = convResult._id.toString();

    console.log(`✓ Test environment ready (User: ${userId}, Conversation: ${conversationId})`);

    // -------------------------------------------------------------
    // Scenario 1: Simple task requiring no tools
    // -------------------------------------------------------------
    console.log("\n[Scenario 1] Testing simple task that requires no tool...");
    {
      mockAI.setHandler(async () => ({
        content: "The capital of France is Paris.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      }));

      setAgentService(new AgentService({ provider: mockAI }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "What is the capital of France?" }),
      });

      assert.equal(res.status, 200, "Scenario 1 must return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.COMPLETED);
      assert.equal(data.output, "The capital of France is Paris.");
      assert.equal(data.userId, userId, "userId must be derived from authenticated context");
      assert.equal(data.stepsCompleted, 1);
      assert.equal(data.toolCalls.length, 0);
      assert.ok(data.executionId);
      assert.ok(data.startedAt);
      assert.ok(data.completedAt);
      assert.ok(data.durationMs >= 0);
      console.log("✓ Scenario 1 Passed: Simple task executed in 1 step with zero tool calls and authenticated userId");
    }

    // -------------------------------------------------------------
    // Scenario 2: Mathematical task that uses the calculator
    // -------------------------------------------------------------
    console.log("\n[Scenario 2] Testing mathematical task that uses the calculator tool...");
    {
      const registry = new ToolRegistry();
      registry.register(calculatorTool);

      mockAI.setHandler(async (messages, _opts, callIndex) => {
        if (callIndex === 0) {
          return {
            content: "Calculating 15 * 8 + 40...",
            provider: "mock",
            model: "mock-model",
            toolCalls: [
              {
                id: "call_math_1",
                name: "calculator",
                arguments: { expression: "15 * 8 + 40" },
              },
            ],
            usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
          };
        }

        // Verify the model received the tool result message
        const lastMsg = messages[messages.length - 1];
        assert.equal(lastMsg?.role, "tool");
        assert.equal(lastMsg?.toolCallId, "call_math_1");
        assert.equal(lastMsg?.name, "calculator");
        const parsedToolOutput = JSON.parse(lastMsg?.content || "{}");
        assert.equal(parsedToolOutput.result, 160);

        return {
          content: "15 * 8 + 40 equals 160.",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 45, outputTokens: 10, totalTokens: 55 },
        };
      });

      setAgentService(new AgentService({ provider: mockAI, registry }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Calculate 15 * 8 + 40" }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.COMPLETED);
      assert.equal(data.output, "15 * 8 + 40 equals 160.");
      assert.equal(data.stepsCompleted, 2);
      assert.equal(data.toolCalls.length, 1);
      assert.equal(data.toolCalls[0].name, "calculator");
      assert.equal(data.toolCalls[0].status, TOOL_CALL_STATUSES.SUCCESS);
      assert.deepEqual(data.toolCalls[0].result, { expression: "15 * 8 + 40", result: 160 });
      assert.equal(data.usage.totalTokens, 95);
      console.log("✓ Scenario 2 Passed: Calculator executed via ToolRegistry → ToolExecutor and returned result to model");
    }

    // -------------------------------------------------------------
    // Scenario 3: Multiple-step tool execution
    // -------------------------------------------------------------
    console.log("\n[Scenario 3] Testing multi-step tool execution cycle...");
    {
      const registry = new ToolRegistry();
      registry.register(calculatorTool);

      mockAI.setHandler(async (_messages, _opts, callIndex) => {
        if (callIndex === 0) {
          return {
            content: "Step 1: Computing 10 + 20...",
            provider: "mock",
            model: "mock-model",
            toolCalls: [
              {
                id: "call_step_1",
                name: "calculator",
                arguments: { expression: "10 + 20" },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          };
        }
        if (callIndex === 1) {
          return {
            content: "Step 2: Multiplying by 3 and adding 50...",
            provider: "mock",
            model: "mock-model",
            toolCalls: [
              {
                id: "call_step_2",
                name: "calculator",
                arguments: { expression: "30 * 3 + 50" },
              },
            ],
            usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
          };
        }
        return {
          content: "The final computed result is 140.",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        };
      });

      setAgentService(new AgentService({ provider: mockAI, registry }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          task: "Compute (10 + 20) * 3 then add 50",
          maxSteps: 5,
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.COMPLETED);
      assert.equal(data.output, "The final computed result is 140.");
      assert.equal(data.stepsCompleted, 3);
      assert.equal(data.toolCalls.length, 2);
      assert.equal(data.toolCalls[0].id, "call_step_1");
      assert.equal(data.toolCalls[1].id, "call_step_2");
      console.log("✓ Scenario 3 Passed: Multi-step sequential tool execution completed cleanly in 3 steps");
    }

    // -------------------------------------------------------------
    // Scenario 4: Unknown / unregistered tool request
    // -------------------------------------------------------------
    console.log("\n[Scenario 4] Testing unknown / unregistered tool request...");
    {
      const registry = new ToolRegistry();
      // Only register calculator; do NOT register weather_service
      registry.register(calculatorTool);

      mockAI.setHandler(async (messages, _opts, callIndex) => {
        if (callIndex === 0) {
          return {
            content: "Calling weather service...",
            provider: "mock",
            model: "mock-model",
            toolCalls: [
              {
                id: "call_unregistered",
                name: "weather_service",
                arguments: { location: "Tokyo" },
              },
            ],
          };
        }

        // Verify model received the error tool message
        const lastMsg = messages[messages.length - 1];
        assert.equal(lastMsg?.role, "tool");
        assert.ok(lastMsg?.content.includes("weather_service"));
        assert.ok(lastMsg?.content.includes("not registered"));

        return {
          content: "Weather service is not available. I can only perform mathematical evaluations.",
          provider: "mock",
          model: "mock-model",
        };
      });

      setAgentService(new AgentService({ provider: mockAI, registry }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Check the weather in Tokyo" }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.COMPLETED);
      assert.equal(data.toolCalls.length, 1);
      assert.equal(data.toolCalls[0].name, "weather_service");
      assert.equal(data.toolCalls[0].status, TOOL_CALL_STATUSES.ERROR);
      assert.equal(data.toolCalls[0].error, "Tool \"weather_service\" is not registered");
      assert.ok(data.output.includes("Weather service is not available"));
      console.log("✓ Scenario 4 Passed: Unregistered tool safely intercepted by ToolExecutor and fed back as tool error");
    }

    // -------------------------------------------------------------
    // Scenario 5: Invalid request & Authentication enforcement
    // -------------------------------------------------------------
    console.log("\n[Scenario 5] Testing invalid requests and authentication enforcement...");
    {
      // 5a. Missing Auth
      const resNoAuth = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "Unauthenticated task" }),
      });
      assert.equal(resNoAuth.status, 401);
      const jsonNoAuth = await resNoAuth.json();
      assert.equal(jsonNoAuth.error.code, "UNAUTHORIZED");

      // 5b. Missing task
      const resMissingTask = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(resMissingTask.status, 400);
      const jsonMissingTask = await resMissingTask.json();
      assert.equal(jsonMissingTask.error.code, "VALIDATION_ERROR");

      // 5c. Empty task
      const resEmptyTask = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "     " }),
      });
      assert.equal(resEmptyTask.status, 400);

      // 5d. Invalid maxSteps (> 25)
      const resBadSteps = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Task", maxSteps: 30 }),
      });
      assert.equal(resBadSteps.status, 400);

      // 5e. Attempt to inject userId
      const resInjectedUser = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Task", userId: "spoofed_admin_id" }),
      });
      assert.equal(resInjectedUser.status, 400);
      console.log("✓ Scenario 5 Passed: Authentication enforced, missing/empty tasks rejected, maxSteps bounded, userId injection blocked");
    }

    // -------------------------------------------------------------
    // Scenario 6: maxSteps limit enforcement (prevents infinite execution)
    // -------------------------------------------------------------
    console.log("\n[Scenario 6] Testing maxSteps limit enforcement...");
    {
      const registry = new ToolRegistry();
      registry.register(calculatorTool);

      // Model keeps requesting tool calls endlessly
      mockAI.setHandler(async () => ({
        content: "Still calculating...",
        provider: "mock",
        model: "mock-model",
        toolCalls: [
          {
            id: "call_infinite",
            name: "calculator",
            arguments: { expression: "1 + 1" },
          },
        ],
      }));

      setAgentService(new AgentService({ provider: mockAI, registry }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          task: "Infinite loop task",
          maxSteps: 2, // Request strict bound of 2 steps
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.FAILED);
      assert.equal(data.error, "Maximum execution steps (2) reached");
      assert.equal(data.stepsCompleted, 2);
      assert.equal(data.output, null);
      console.log("✓ Scenario 6 Passed: maxSteps strictly halted execution at step 2, preventing infinite loop");
    }

    // -------------------------------------------------------------
    // Scenario 7: Provider failure handling & secret protection
    // -------------------------------------------------------------
    console.log("\n[Scenario 7] Testing provider failure handling & secret protection...");
    {
      mockAI.setHandler(async () => {
        throw new Error("Provider rate limit (429): connection dropped");
      });

      setAgentService(new AgentService({ provider: mockAI }));

      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ task: "Crash provider task" }),
      });

      assert.equal(res.status, 200, "Controlled failure returns HTTP 200 with status FAILED");
      const json = await res.json();
      assert.equal(json.success, true);
      const data = json.data;

      assert.equal(data.status, AGENT_STATUSES.FAILED);
      assert.equal(data.output, null);
      assert.equal(data.error, "Provider rate limit (429): connection dropped");
      assert.ok(data.executionId);
      assert.equal(json.stack, undefined, "Stack trace must NEVER be exposed");
      assert.equal(json.error, undefined, "HTTP response must not be uncaught error");
      console.log("✓ Scenario 7 Passed: Provider failure safely captured as controlled FAILED result without leaking secrets");
    }

    // -------------------------------------------------------------
    // Scenario 8: Existing /api/v1/ai/chat still works unchanged
    // -------------------------------------------------------------
    console.log("\n[Scenario 8] Testing existing /api/v1/ai/chat endpoint works unchanged...");
    {
      const chatMockAI: AIProvider = {
        name: "mock-chat",
        async generateChatResponse() {
          return {
            content: "NexaMind chat assistant response.",
            provider: "mock-chat",
            model: "mock-chat-model",
            usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
          };
        },
      };

      orchestratorService.setDefaultProvider(chatMockAI);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          conversationId,
          content: "Hello from verification test",
        }),
      });

      assert.equal(res.status, 200, "Chat route must return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.userMessage);
      assert.ok(json.data.assistantMessage);
      assert.equal(json.data.userMessage.content, "Hello from verification test");
      assert.equal(json.data.assistantMessage.content, "NexaMind chat assistant response.");
      assert.equal(json.data.conversation.id, conversationId);
      console.log("✓ Scenario 8 Passed: Existing /api/v1/ai/chat functionality operates completely unchanged");
    }

    console.log("\n==================================================================");
    console.log(" ALL STEP 10 END-TO-END AGENT SCENARIOS PASSED SUCCESSFULLY ");
    console.log("==================================================================");
  } finally {
    // Teardown
    setAgentService(agentService);
    orchestratorService.setDefaultProvider(initialChatProvider);

    if (userId) {
      await TokenBalance.deleteMany({ userId });
      await Message.deleteMany({ userId });
      await Conversation.deleteMany({ userId });
      await User.deleteMany({ _id: userId });
    }

    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Step 10 E2E Verification Suite Failed:", err);
  process.exit(1);
});
