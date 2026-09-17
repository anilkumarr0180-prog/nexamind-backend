import assert from "node:assert/strict";
import { AppError } from "../src/errors/app.error.js";
import {
  AgentService,
  executeAgentTask,
  resolveMaxSteps,
  validateAgentInput,
  DEFAULT_MAX_STEPS,
  MAX_ALLOWED_STEPS,
  MIN_ALLOWED_STEPS,
  ToolRegistry,
  calculatorTool,
  AGENT_STATUSES,
  TOOL_CALL_STATUSES,
  type AgentExecutionInput,
} from "../src/modules/agent/index.js";
import type {
  AIMessage,
  AIProvider,
  AIResponse,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

/**
 * Controllable Mock AI Provider for deterministic testing of the Agent Service.
 */
class MockAIProvider implements AIProvider {
  public readonly name = "mock_provider";
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
  console.log("=== Starting Agent Core: Agent Service Unit Tests ===");

  // -------------------------------------------------------------
  // Test 1: Valid Execution
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing valid execution...");
  {
    const provider = new MockAIProvider(async () => ({
      content: "Execution completed successfully.",
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));

    const service = new AgentService({ provider });

    const input: AgentExecutionInput = {
      userId: "user_valid_1",
      task: "Run system check",
    };

    const result = await service.execute(input);

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.output, "Execution completed successfully.");
    assert.equal(result.userId, "user_valid_1");
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.toolCalls.length, 0);
    assert.ok(result.durationMs >= 0);
    console.log("✓ Valid execution handled cleanly and returned AgentExecutionResult");
  }

  // -------------------------------------------------------------
  // Test 2: Invalid Task / Input
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing invalid task and input validation...");
  {
    const service = new AgentService();

    // Missing / null input
    await assert.rejects(
      async () => service.execute(null as any),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );

    // Missing userId
    await assert.rejects(
      async () => service.execute({ userId: "   ", task: "Perform task" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "INVALID_INPUT");
        assert.ok(err.message.includes("userId is required"));
        return true;
      },
    );

    // Missing task
    await assert.rejects(
      async () => service.execute({ userId: "u1", task: "   " }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "INVALID_INPUT");
        assert.ok(err.message.includes("task is required"));
        return true;
      },
    );

    // Direct helper validation check
    assert.throws(
      () => validateAgentInput({ userId: "", task: "" }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400,
    );

    console.log("✓ Invalid inputs rejected with AppError(400, INVALID_INPUT)");
  }

  // -------------------------------------------------------------
  // Test 3: maxSteps Handling & Boundaries
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing maxSteps handling & safety boundaries...");
  {
    // Test resolution function boundaries
    assert.equal(resolveMaxSteps(undefined), DEFAULT_MAX_STEPS);
    assert.equal(resolveMaxSteps(0), DEFAULT_MAX_STEPS);
    assert.equal(resolveMaxSteps(-5), DEFAULT_MAX_STEPS);
    assert.equal(resolveMaxSteps(NaN), DEFAULT_MAX_STEPS);
    assert.equal(resolveMaxSteps(Infinity), DEFAULT_MAX_STEPS);
    assert.equal(resolveMaxSteps(5), 5);
    assert.equal(resolveMaxSteps(5.8), 5);
    assert.equal(resolveMaxSteps(100), MAX_ALLOWED_STEPS); // Clamped to 25
    assert.equal(resolveMaxSteps(MIN_ALLOWED_STEPS), 1);

    // Test integration with loop execution: custom maxSteps enforced
    const infiniteProvider = new MockAIProvider(async (messages, options, callIndex) => ({
      content: "",
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      toolCalls: [
        {
          id: `step_${callIndex}`,
          name: "calculator",
          arguments: { expression: `${callIndex} + 1` },
        },
      ],
    }));

    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const service = new AgentService({ provider: infiniteProvider, registry });

    // Request with maxSteps: 2
    const result = await service.execute({
      userId: "u_steps",
      task: "Infinite tool calls",
      maxSteps: 2,
    });

    assert.equal(result.status, AGENT_STATUSES.FAILED);
    assert.equal(result.stepsCompleted, 2);
    assert.ok(result.error?.includes("Maximum execution steps (2) reached"));

    // Request with excessive maxSteps (e.g. 50) -> should clamp to MAX_ALLOWED_STEPS (25)
    // We test resolveMaxSteps clamping
    assert.equal(resolveMaxSteps(50), 25);

    console.log("✓ maxSteps safely resolved and bounded, preventing unbounded execution");
  }

  // -------------------------------------------------------------
  // Test 4: Successful Agent Result with Tool Calling
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing successful agent result with tool calling...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          toolCalls: [
            {
              id: "call_sum",
              name: "calculator",
              arguments: { expression: "25 + 75" },
            },
          ],
        };
      }
      return {
        content: "25 + 75 equals 100.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 35, outputTokens: 8, totalTokens: 43 },
      };
    });

    const result = await executeAgentTask(
      {
        userId: "user_calc",
        task: "Compute sum",
      },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.output, "25 + 75 equals 100.");
    assert.equal(result.stepsCompleted, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.SUCCESS);
    assert.equal((result.toolCalls[0].result as { result: number }).result, 100);
    assert.equal(result.usage.totalTokens, 73);
    console.log("✓ Successful agent execution with tool calls verified");
  }

  // -------------------------------------------------------------
  // Test 5: Failed Agent Result
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing failed agent result...");
  {
    const failingProvider = new MockAIProvider(async () => {
      throw new Error("AI provider rate limit exceeded");
    });

    const service = new AgentService({ provider: failingProvider });

    const result = await service.execute({
      userId: "user_fail",
      task: "Trigger error",
    });

    assert.equal(result.status, AGENT_STATUSES.FAILED);
    assert.equal(result.output, null);
    assert.equal(result.error, "AI provider rate limit exceeded");
    assert.equal(result.stepsCompleted, 0);
    assert.ok(result.durationMs >= 0);
    console.log("✓ Failed agent result captured safely without unhandled exceptions");
  }

  // -------------------------------------------------------------
  // Test 6: Propagation of conversationId / userId / metadata
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing propagation of conversationId and userId...");
  {
    const provider = new MockAIProvider(async () => ({
      content: "Context preserved.",
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));

    const service = new AgentService({ provider });

    const input: AgentExecutionInput = {
      userId: "user_prop_123",
      conversationId: "conv_prop_456",
      task: "Check context propagation",
      metadata: { source: "test_suite", priority: "high" },
    };

    const result = await service.execute(input);

    assert.equal(result.userId, "user_prop_123");
    assert.equal(result.conversationId, "conv_prop_456");
    assert.deepEqual(result.metadata, { source: "test_suite", priority: "high" });
    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    console.log("✓ userId, conversationId, and metadata propagated accurately");
  }

  console.log("\n==================================================");
  console.log(" ALL AGENT SERVICE UNIT TESTS PASSED (6/6)       ");
  console.log("==================================================\n");
};

runTests().catch((err) => {
  console.error("Agent Service Unit Tests Failed:", err);
  process.exit(1);
});
