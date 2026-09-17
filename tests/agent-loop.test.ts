import assert from "node:assert/strict";
import {
  AgentLoop,
  runAgentLoop,
  ToolRegistry,
  ToolExecutor,
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
 * Controllable Mock AI Provider for deterministic testing of the Agent Loop.
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
  console.log("=== Starting Agent Core: Agent Loop Unit Tests ===");

  // -------------------------------------------------------------
  // Test 1: Normal response without tools
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing normal response without tools...");
  {
    const registry = new ToolRegistry();
    const provider = new MockAIProvider(async () => ({
      content: "Hello! How can I help you today?",
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    }));

    const input: AgentExecutionInput = {
      userId: "user_test_1",
      task: "Hello there",
    };

    const result = await runAgentLoop(input, { provider, registry });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.output, "Hello! How can I help you today?");
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 8);
    assert.equal(result.usage.totalTokens, 18);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].messages.length, 1);
    assert.equal(provider.calls[0].messages[0].role, "user");
    assert.equal(provider.calls[0].messages[0].content, "Hello there");
    assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
    console.log("✓ Normal response without tools completed in 1 step with usage tracked");
  }

  // -------------------------------------------------------------
  // Test 2: One successful calculator tool call
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing one successful calculator tool call...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        // Model requests calculator
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
          toolCalls: [
            {
              id: "call_calc_45_2",
              name: "calculator",
              arguments: { expression: "45 * 2 + 10" },
            },
          ],
        };
      }

      // Model receives calculation result and produces final answer
      return {
        content: "The calculation of 45 * 2 + 10 equals 100.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
      };
    });

    const input: AgentExecutionInput = {
      userId: "user_test_2",
      task: "What is 45 * 2 + 10?",
      conversationId: "conv_test_2",
    };

    const result = await runAgentLoop(input, { provider, registry });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.output, "The calculation of 45 * 2 + 10 equals 100.");
    assert.equal(result.stepsCompleted, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "calculator");
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.SUCCESS);
    assert.equal((result.toolCalls[0].result as { result: number }).result, 100);
    assert.equal(result.conversationId, "conv_test_2");
    assert.equal(result.usage.totalTokens, 87); // 35 + 52
    assert.equal(provider.calls.length, 2);

    // Verify conversation messages flow sent to provider in step 2
    const secondCallMessages = provider.calls[1].messages;
    assert.equal(secondCallMessages.length, 3);
    assert.equal(secondCallMessages[0].role, "user");
    assert.equal(secondCallMessages[1].role, "assistant");
    assert.deepEqual(secondCallMessages[1].toolCalls, [
      {
        id: "call_calc_45_2",
        name: "calculator",
        arguments: { expression: "45 * 2 + 10" },
      },
    ]);
    assert.equal(secondCallMessages[2].role, "tool");
    assert.equal(secondCallMessages[2].toolCallId, "call_calc_45_2");
    assert.ok(secondCallMessages[2].content.includes('"result":100') || secondCallMessages[2].content.includes('"result": 100'));
    console.log("✓ Single calculator tool call executed, fed back to model, and completed");
  }

  // -------------------------------------------------------------
  // Test 3: Multiple tool iterations
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing multiple tool iterations...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          toolCalls: [
            {
              id: "call_step_1",
              name: "calculator",
              arguments: { expression: "12 * 3" },
            },
          ],
        };
      }
      if (callIndex === 1) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
          toolCalls: [
            {
              id: "call_step_2",
              name: "calculator",
              arguments: { expression: "36 + 14" },
            },
          ],
        };
      }
      return {
        content: "First 12*3 was 36, then 36+14 gave 50. Total is 50.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 40, outputTokens: 15, totalTokens: 55 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_3", task: "Chain 12*3 and add 14" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.stepsCompleted, 3);
    assert.equal(result.toolCalls.length, 2);
    assert.equal((result.toolCalls[0].result as { result: number }).result, 36);
    assert.equal((result.toolCalls[1].result as { result: number }).result, 50);
    assert.equal(result.usage.totalTokens, 115);
    assert.equal(provider.calls.length, 3);
    console.log("✓ Multiple tool iterations executed sequentially with state preserved");
  }

  // -------------------------------------------------------------
  // Test 4: Unknown tool handling
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing unknown / unregistered tool handling...");
  {
    const registry = new ToolRegistry(); // Empty registry - tool not registered

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          toolCalls: [
            {
              id: "call_unknown_99",
              name: "system_shell_exec",
              arguments: { cmd: "ls" },
            },
          ],
        };
      }
      // Model sees tool error and responds gracefully
      return {
        content: "I cannot execute system commands as that tool is not available.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_4", task: "Run shell command" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.stepsCompleted, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "system_shell_exec");
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.ERROR);
    assert.ok(result.toolCalls[0].error?.includes("not registered"));

    // Check message sent to model in step 2 contains the controlled error
    const secondCallMessages = provider.calls[1].messages;
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    assert.ok(toolMsg?.content.includes("not registered"));
    console.log("✓ Unregistered tool rejected safely, fed back to model without crashing loop");
  }

  // -------------------------------------------------------------
  // Test 5: Tool failure (e.g. division by zero)
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing tool failure handling...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          toolCalls: [
            {
              id: "call_div_zero",
              name: "calculator",
              arguments: { expression: "100 / 0" },
            },
          ],
        };
      }
      return {
        content: "Mathematically, division by zero is undefined.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 35, outputTokens: 8, totalTokens: 43 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_5", task: "Divide 100 by 0" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.stepsCompleted, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.ERROR);
    assert.ok(result.toolCalls[0].error?.includes("Division by zero"));
    console.log("✓ Tool execution error captured, marked as ERROR, and recovered by model");
  }

  // -------------------------------------------------------------
  // Test 6: maxSteps reached
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing maxSteps reached limit...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    // Mock provider that attempts to loop indefinitely by requesting calculator each time
    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      return {
        content: "",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [
          {
            id: `call_infinite_${callIndex}`,
            name: "calculator",
            arguments: { expression: `${callIndex} + 1` },
          },
        ],
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_6", task: "Loop forever", maxSteps: 3 },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.FAILED);
    assert.equal(result.stepsCompleted, 3);
    assert.equal(result.toolCalls.length, 3);
    assert.equal(result.output, null);
    assert.ok(result.error?.includes("Maximum execution steps"));
    assert.ok(result.error?.includes("3"));
    assert.equal(provider.calls.length, 3); // Strictly stopped at maxSteps
    console.log("✓ maxSteps reached enforced strictly, preventing infinite loops");
  }

  // -------------------------------------------------------------
  // Test 7: Provider failure
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing provider failure handling...");
  {
    const registry = new ToolRegistry();
    const provider = new MockAIProvider(async () => {
      throw new Error("AI provider upstream 502 Bad Gateway");
    });

    const result = await runAgentLoop(
      { userId: "user_test_7", task: "Will fail upstream" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.FAILED);
    assert.equal(result.error, "AI provider upstream 502 Bad Gateway");
    assert.equal(result.output, null);
    assert.equal(result.stepsCompleted, 0);
    assert.ok(result.startedAt instanceof Date);
    assert.ok(result.completedAt instanceof Date);
    assert.ok(result.durationMs >= 0);
    console.log("✓ Unrecoverable provider error converted to controlled FAILED result");
  }

  // -------------------------------------------------------------
  // Test 8: Final output returned correctly
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing final output returned correctly...");
  {
    const expectedOutput = `### Analysis Report\n1. Metrics evaluated: OK\n2. Status: Verified\nConclusion: All systems operational.`;
    const registry = new ToolRegistry();
    const provider = new MockAIProvider(async () => ({
      content: expectedOutput,
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 50, outputTokens: 40, totalTokens: 90 },
    }));

    const result = await runAgentLoop(
      {
        userId: "user_test_8",
        task: "Generate analysis report",
        systemPrompt: "You are a precise technical analyst.",
        metadata: { category: "audit" },
      },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.output, expectedOutput);
    assert.deepEqual(result.metadata, { category: "audit" });
    assert.equal(provider.calls[0].messages[0].role, "system");
    assert.equal(provider.calls[0].messages[0].content, "You are a precise technical analyst.");
    console.log("✓ Final structured output and metadata preserved with total fidelity");
  }

  // -------------------------------------------------------------
  // Test 9: Execution duration tracked
  // -------------------------------------------------------------
  console.log("\n[Test 9] Testing execution duration tracking...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      // Simulate slight network delay
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [
            {
              id: "call_timed_1",
              name: "calculator",
              arguments: { expression: "20 * 5" },
            },
          ],
        };
      }
      return {
        content: "Result is 100",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_9", task: "Calculate 20*5" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.ok(result.durationMs >= 20, `Expected durationMs >= 20, got ${result.durationMs}`);
    assert.ok(result.completedAt.getTime() >= result.startedAt.getTime());
    assert.ok(result.toolCalls.length === 1);
    assert.ok(typeof result.toolCalls[0].durationMs === "number");
    assert.ok(result.toolCalls[0].durationMs! >= 0);
    console.log(`✓ Execution duration (${result.durationMs}ms) and tool duration tracked accurately`);
  }

  // -------------------------------------------------------------
  // Test 10: Input validation edge cases
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing input validation edge cases...");
  {
    const resultMissingTask = await runAgentLoop({ userId: "u1", task: "  " });
    assert.equal(resultMissingTask.status, AGENT_STATUSES.FAILED);
    assert.ok(resultMissingTask.error?.includes("userId and task are required"));

    const resultMissingUser = await runAgentLoop({ userId: "", task: "do something" });
    assert.equal(resultMissingUser.status, AGENT_STATUSES.FAILED);
    assert.ok(resultMissingUser.error?.includes("userId and task are required"));
    console.log("✓ Invalid input handled cleanly without crashing");
  }

  console.log("\n==================================================");
  console.log(" ALL AGENT LOOP UNIT TESTS PASSED (10/10)        ");
  console.log("==================================================\n");
};

runTests().catch((err) => {
  console.error("Agent Loop Unit Tests Failed:", err);
  process.exit(1);
});
