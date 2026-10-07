import assert from "node:assert/strict";
import {
  AgentLoop,
  runAgentLoop,
  ToolRegistry,
  ToolExecutor,
  calculatorTool,
  WebSearchTool,
  type AgentTraceStep,
  type AgentPlan,
  type PlanStep,
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


  // -------------------------------------------------------------
  // Test 11: Web Search -> Calculator multi-step execution flow
  // (Goal: "Search the latest USD/INR rate and calculate the value of $500.")
  // -------------------------------------------------------------
  console.log("\n[Test 11] Testing Web Search -> Calculator sequential multi-step execution flow...");
  {
    const registry = new ToolRegistry();
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Live Currency Exchange Rates: USD to INR",
            url: "https://example.com/currency/usd-inr",
            content: "As of today, 1 USD is equal to 86.5 INR in global markets.",
          },
        ],
      }),
    });
    const mockWebSearchTool = new WebSearchTool({
      apiKey: "mock-key",
      fetchFn: mockFetch as any,
      disableCache: true,
    });
    registry.register(mockWebSearchTool);
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        // Step 1: Agent decides to search for the exchange rate
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
          toolCalls: [
            {
              id: "call_ws_rate",
              name: "web_search",
              arguments: { query: "latest USD to INR exchange rate" },
            },
          ],
        };
      }
      if (callIndex === 1) {
        // Step 2: Agent inspects retrieved rate (86.5) and decides to calculate 500 * 86.5
        const lastMsg = messages[messages.length - 1];
        assert.equal(lastMsg.role, "tool");
        assert.equal(lastMsg.name, "web_search");
        assert.ok(lastMsg.content.includes("86.5"));

        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 45, outputTokens: 12, totalTokens: 57 },
          toolCalls: [
            {
              id: "call_calc_500",
              name: "calculator",
              arguments: { expression: "500 * 86.5" },
            },
          ],
        };
      }
      // Step 3: Agent produces final response combining web search facts and exact calculation
      const lastMsg = messages[messages.length - 1];
      assert.equal(lastMsg.role, "tool");
      assert.equal(lastMsg.name, "calculator");
      assert.ok(lastMsg.content.includes("43250"));

      return {
        content: "Based on the latest USD/INR rate of 86.5 [1], the value of $500 is 43,250 INR.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 55, outputTokens: 25, totalTokens: 80 },
      };
    });

    const emittedToolStatuses: any[] = [];
    const emittedTraceSteps: AgentTraceStep[] = [];
    const emittedSources: any[] = [];

    const result = await runAgentLoop(
      {
        userId: "user_test_multi",
        task: "Search the latest USD/INR rate and calculate the value of $500.",
      },
      {
        provider,
        registry,
      },
      {
        callbacks: {
          onToolStatus: (s) => emittedToolStatuses.push(s),
          onTrace: (t) => emittedTraceSteps.push(t),
          onSources: (srcs) => emittedSources.push(...srcs),
        },
      },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.stepsCompleted, 3);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "web_search");
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.SUCCESS);
    assert.equal(result.toolCalls[1].name, "calculator");
    assert.equal(result.toolCalls[1].status, TOOL_CALL_STATUSES.SUCCESS);
    assert.ok(result.output?.includes("43,250"));
    assert.ok(result.output?.includes("86.5"));

    // Verify structured trace tracking
    assert.ok(result.trace, "Result must contain structured trace");
    assert.ok(result.trace.length >= 5, "Trace must contain all execution steps");
    assert.equal(result.trace[0].type, "tool_call");
    assert.equal(result.trace[0].tool, "web_search");
    assert.equal(result.trace[1].type, "tool_result");
    assert.equal(result.trace[1].tool, "web_search");
    assert.equal(result.trace[2].type, "tool_call");
    assert.equal(result.trace[2].tool, "calculator");
    assert.equal(result.trace[3].type, "tool_result");
    assert.equal(result.trace[3].tool, "calculator");
    const lastTrace = result.trace[result.trace.length - 1];
    assert.equal(lastTrace.type, "final_response");

    // Verify sources collected
    assert.ok(result.sources && result.sources.length > 0, "Sources must be attached to result");
    assert.equal(result.sources[0].url, "https://example.com/currency/usd-inr");
    assert.ok(emittedSources.length > 0, "onSources callback must be emitted");

    console.log("✓ Web Search -> Calculator multi-step execution flow completed cleanly with trace and sources");
  }

  // -------------------------------------------------------------
  // Test 12: Repeated tool failure protection
  // -------------------------------------------------------------
  console.log("\n[Test 12] Testing repeated failure protection against infinite retry loops...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    let calculatorExecutionCount = 0;
    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        // Step 1: Model requests invalid calculation
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          toolCalls: [
            {
              id: "call_fail_1",
              name: "calculator",
              arguments: { expression: "100 / 0" },
            },
          ],
        };
      }
      if (callIndex === 1) {
        // Step 2: Model attempts 1st retry (allowed in case of flakey/transient error)
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 },
          toolCalls: [
            {
              id: "call_fail_2",
              name: "calculator",
              arguments: { expression: "100 / 0" },
            },
          ],
        };
      }
      if (callIndex === 2) {
        // Step 3: Model attempts repeated failing call -> intercepted!
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
          toolCalls: [
            {
              id: "call_fail_3",
              name: "calculator",
              arguments: { expression: "100 / 0" },
            },
          ],
        };
      }
      // Step 4: Model receives repeated failure protection notice and provides final answer
      return {
        content: "Division by zero is undefined, so the expression cannot be calculated.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 35, outputTokens: 10, totalTokens: 45 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_repeat", task: "Divide 100 by zero repeatedly" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.stepsCompleted, 4);
    assert.equal(result.toolCalls.length, 3);
    assert.equal(result.toolCalls[0].status, TOOL_CALL_STATUSES.ERROR);
    assert.equal(result.toolCalls[1].status, TOOL_CALL_STATUSES.ERROR);
    assert.equal(result.toolCalls[2].status, TOOL_CALL_STATUSES.ERROR);
    assert.ok(
      result.toolCalls[2].error?.includes("previously failed with identical arguments"),
      "Third call must be intercepted by repeated failure protection",
    );
    assert.ok(result.output?.includes("undefined"));
    console.log("✓ Repeated tool failure intercepted and prevented infinite retry loop");
  }

  // -------------------------------------------------------------
  // Test 13: Execution trace detail & lifecycle timestamps
  // -------------------------------------------------------------
  console.log("\n[Test 13] Testing structured execution trace detail & lifecycle timestamps...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [
            {
              id: "call_trace_calc",
              name: "calculator",
              arguments: { expression: "15 + 25" },
            },
          ],
        };
      }
      return {
        content: "15 + 25 = 40",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      };
    });

    const streamedTrace: AgentTraceStep[] = [];
    const result = await runAgentLoop(
      { userId: "user_test_trace", task: "Add 15 and 25" },
      { provider, registry },
      {
        callbacks: {
          onTrace: (step) => streamedTrace.push(step),
        },
      },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.ok(result.trace);
    assert.equal(result.trace.length, 3); // tool_call, tool_result, final_response
    assert.equal(streamedTrace.length, 3);

    for (const step of result.trace) {
      assert.ok(typeof step.step === "number" && step.step >= 1);
      assert.ok(typeof step.timestamp === "string" && !isNaN(Date.parse(step.timestamp)));
      assert.ok(step.status === "running" || step.status === "completed" || step.status === "failed");
    }

    console.log("✓ Execution trace structured steps, timestamps, and streaming callbacks verified");
  }

  // -------------------------------------------------------------
  // Test 14: Mid-execution cancellation via AbortSignal
  // -------------------------------------------------------------
  console.log("\n[Test 14] Testing cancellation mid-execution via AbortSignal...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const abortController = new AbortController();

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      // Abort after first model step
      abortController.abort();
      return {
        content: "",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [
          {
            id: "call_cancel_1",
            name: "calculator",
            arguments: { expression: "5 + 5" },
          },
        ],
      };
    });

    const result = await runAgentLoop(
      { userId: "user_test_cancel", task: "Cancel this task" },
      { provider, registry },
      { signal: abortController.signal },
    );

    assert.equal(result.status, AGENT_STATUSES.CANCELLED);
    console.log("✓ Mid-execution AbortSignal cleanly cancelled agent loop");
  }


  // -------------------------------------------------------------
  // Test 15: Plan generation and step status updates for single tool request
  // -------------------------------------------------------------
  console.log("\n[Test 15] Testing Plan generation and step status updates for single tool request...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [
            {
              id: "call_calc_plan",
              name: "calculator",
              arguments: { expression: "25 + 75" },
            },
          ],
        };
      }
      return {
        content: "25 + 75 = 100",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      };
    });

    const emittedPlans: AgentPlan[] = [];
    const result = await runAgentLoop(
      { userId: "user_plan_single", task: "Calculate 25 + 75" },
      { provider, registry },
      {
        callbacks: {
          onPlan: (plan) => emittedPlans.push(JSON.parse(JSON.stringify(plan))),
        },
      },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.ok(result.plan, "Result must include plan");
    assert.equal(result.plan.steps.length, 2);
    assert.equal(result.plan.steps[0].title, "Calculate the result");
    assert.equal(result.plan.steps[0].status, "completed");
    assert.equal(result.plan.steps[1].title, "Generate the answer");
    assert.equal(result.plan.steps[1].status, "completed");

    // Verify lifecycle emission of plans
    assert.ok(emittedPlans.length >= 3, "Must emit plan at each lifecycle transition");
    // Initial plan: pending
    assert.equal(emittedPlans[0].steps[0].status, "pending");
    assert.equal(emittedPlans[0].steps[1].status, "pending");
    // As tool runs: running
    const runningPlan = emittedPlans.find((p) => p.steps[0].status === "running");
    assert.ok(runningPlan, "Must emit plan with running status");
    // Final plan: all completed
    const finalPlan = emittedPlans[emittedPlans.length - 1];
    assert.equal(finalPlan.steps[0].status, "completed");
    assert.equal(finalPlan.steps[1].status, "completed");

    console.log("✓ Plan generation and step status updates (pending -> running -> completed) verified for single tool");
  }

  // -------------------------------------------------------------
  // Test 16: Plan preview and sequential step transitions for Web Search -> Calculator
  // -------------------------------------------------------------
  console.log("\n[Test 16] Testing Plan preview for Web Search -> Calculator multi-step request...");
  {
    const registry = new ToolRegistry();
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ title: "Rate", url: "https://example.com/fx", content: "1 USD = 86.5 INR" }],
      }),
    });
    const mockWebSearchTool = new WebSearchTool({
      apiKey: "mock-key",
      fetchFn: mockFetch as any,
      disableCache: true,
    });
    registry.register(mockWebSearchTool);
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          toolCalls: [{ id: "call_ws", name: "web_search", arguments: { query: "USD/INR rate" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
          toolCalls: [{ id: "call_calc", name: "calculator", arguments: { expression: "500 * 86.5" } }],
        };
      }
      return {
        content: "500 USD is 43,250 INR.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      };
    });

    const emittedPlans: AgentPlan[] = [];
    const result = await runAgentLoop(
      { userId: "user_plan_multi", task: "Search the latest USD/INR rate and calculate the value of $500." },
      { provider, registry },
      {
        callbacks: {
          onPlan: (plan) => emittedPlans.push(JSON.parse(JSON.stringify(plan))),
        },
      },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.ok(result.plan);
    assert.equal(result.plan.steps.length, 3);
    assert.equal(result.plan.steps[0].title, "Search current information");
    assert.equal(result.plan.steps[0].status, "completed");
    assert.equal(result.plan.steps[1].title, "Calculate the result");
    assert.equal(result.plan.steps[1].status, "completed");
    assert.equal(result.plan.steps[2].title, "Generate the answer");
    assert.equal(result.plan.steps[2].status, "completed");

    // Check step 1 initially running while step 2 is pending
    const step1Running = emittedPlans.find(
      (p) => p.steps[0].status === "running" && p.steps[1].status === "pending",
    );
    assert.ok(step1Running, "Step 1 must be running while step 2 is pending");

    // Check step 1 completed while step 2 running
    const step2Running = emittedPlans.find(
      (p) => p.steps[0].status === "completed" && p.steps[1].status === "running",
    );
    assert.ok(step2Running, "Step 1 must be completed while step 2 is running");

    console.log("✓ Plan preview for Web Search -> Calculator updated correctly across multi-step lifecycle");
  }

  // -------------------------------------------------------------
  // Test 17: Plan step status on tool failure
  // -------------------------------------------------------------
  console.log("\n[Test 17] Testing Plan step status on tool failure...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const provider = new MockAIProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [{ id: "call_fail", name: "calculator", arguments: { expression: "10 / 0" } }],
        };
      }
      return {
        content: "Division by zero is undefined.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    });

    const result = await runAgentLoop(
      { userId: "user_plan_fail", task: "Calculate 10 / 0" },
      { provider, registry },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.ok(result.plan);
    assert.equal(result.plan.steps[0].status, "failed");
    assert.ok(result.plan.steps[0].error?.includes("Division by zero"));
    assert.equal(result.plan.steps[1].status, "completed");
    console.log("✓ Plan step status accurately marked as failed with error details on tool failure");
  }

  // -------------------------------------------------------------
  // Test 18: Plan step status on cancellation
  // -------------------------------------------------------------
  console.log("\n[Test 18] Testing Plan step status on cancellation...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const abortController = new AbortController();
    const provider = new MockAIProvider(async () => {
      abortController.abort();
      return {
        content: "",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [{ id: "call_c", name: "calculator", arguments: { expression: "2 + 2" } }],
      };
    });

    const result = await runAgentLoop(
      { userId: "user_plan_cancel", task: "Calculate 2 + 2 and cancel" },
      { provider, registry },
      { signal: abortController.signal },
    );

    assert.equal(result.status, AGENT_STATUSES.CANCELLED);
    assert.ok(result.plan);
    // Unfinished steps marked skipped
    assert.ok(result.plan.steps.every((s) => s.status === "skipped" || s.status === "completed"));
    console.log("✓ Plan step status on cancellation correctly marked remaining steps as skipped");
  }

  console.log("\n==================================================");
  console.log(" ALL AGENT LOOP UNIT TESTS PASSED (18/18)        ");
  console.log("==================================================\n");
};

runTests().catch((err) => {
  console.error("Agent Loop Unit Tests Failed:", err);
  process.exit(1);
});
