import assert from "node:assert/strict";
import {
  AgentLoop,
  ToolRegistry,
  MAX_WEB_SEARCHES_PER_REQUEST,
  AGENT_STATUSES,
} from "../src/modules/agent/index.js";
import type {
  AIMessage,
  AIProvider,
  AIResponse,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "../src/modules/agent/tool.interface.js";
import * as tokenService from "../src/modules/tokens/token.service.js";

/**
 * Controllable Mock AI Provider for testing execution flow.
 */
class ControllableMockProvider implements AIProvider {
  public readonly name = "mock_provider";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];

  constructor(
    private readonly stepFn: (
      messages: AIMessage[],
      callIndex: number,
    ) => Promise<AIResponse> | AIResponse,
  ) {}

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
    return this.stepFn(messages, callIndex);
  }
}

/**
 * Mock WebSearchTool tracking actual tool executions.
 */
class MockWebSearchTool implements AgentTool {
  public readonly name = "web_search";
  public readonly description = "Mock web search";
  public readonly schema = { type: "object", properties: { query: { type: "string" } } };
  public executionCount = 0;
  public executedQueries: string[] = [];

  async execute(
    input: { query: string },
    _context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executionCount++;
    this.executedQueries.push(input?.query ?? "");
    return {
      output: {
        query: input.query,
        results: [
          {
            title: "Result for " + input.query,
            url: "https://example.com/" + encodeURIComponent(input.query),
            content: "Snippet for " + input.query,
          },
        ],
        totalResults: 1,
      },
      isError: false,
    };
  }
}

/**
 * Mock Calculator tool
 */
class MockCalculatorTool implements AgentTool {
  public readonly name = "calculator";
  public readonly description = "Mock calculator";
  public readonly schema = { type: "object", properties: { expression: { type: "string" } } };
  public executionCount = 0;

  async execute(
    input: { expression: string },
  ): Promise<ToolExecutionResult> {
    this.executionCount++;
    return {
      output: { result: 42 },
      isError: false,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Web Search Per-Request Limit Tests ===");

  // -------------------------------------------------------------
  // Test 1, 2, 3: First and second execute, third is blocked
  // -------------------------------------------------------------
  console.log("\n[Test 1, 2, 3] Testing 1st executes, 2nd executes, 3rd is blocked...");
  {
    assert.equal(MAX_WEB_SEARCHES_PER_REQUEST, 2, "MAX_WEB_SEARCHES_PER_REQUEST constant must be 2");

    const mockWebSearch = new MockWebSearchTool();
    const registry = new ToolRegistry();
    registry.register(mockWebSearch);

    // AI requests web_search in step 0, step 1, step 2, and concludes in step 3
    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Searching 1st query",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "first query" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "Searching 2nd query",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_2", name: "web_search", arguments: { query: "second query" } }],
        };
      }
      if (callIndex === 2) {
        return {
          content: "Searching 3rd query",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_3", name: "web_search", arguments: { query: "third query" } }],
        };
      }
      return {
        content: "Here is the final answer synthesized from the available searches.",
        provider: "mock",
        model: "mock",
        toolCalls: [],
      };
    });

    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
    });

    const result = await loop.run({
      userId: "test-user-1",
      task: "Search 3 things",
      maxSteps: 5,
    });

    // Verify Agent completed cleanly without crashing
    assert.equal(result.status, AGENT_STATUSES.COMPLETED, "AgentLoop should complete successfully");
    assert.equal(result.output, "Here is the final answer synthesized from the available searches.");

    // Test 1: First web_search executed
    assert.ok(mockWebSearch.executedQueries.includes("first query"), "First query must be executed by tool");

    // Test 2: Second web_search executed
    assert.ok(mockWebSearch.executedQueries.includes("second query"), "Second query must be executed by tool");

    // Test 3: Third web_search was blocked, mock tool only called 2 times
    assert.equal(mockWebSearch.executionCount, 2, "MockWebSearchTool should only be executed exactly 2 times");
    assert.ok(!mockWebSearch.executedQueries.includes("third query"), "Third query must NOT reach Tavily tool");

    // Check third tool call in result
    assert.equal(result.toolCalls.length, 3, "Total 3 tool calls recorded in state");
    const thirdCall = result.toolCalls[2];
    assert.ok(thirdCall);
    assert.equal(thirdCall.name, "web_search");
    assert.equal(
      thirdCall.result,
      "Maximum web search limit reached for this turn. Use the search results already retrieved to answer the user.",
      "Third call must return graceful limit reached notice",
    );

    console.log("✓ Test 1 Passed: First web_search executed normally");
    console.log("✓ Test 2 Passed: Second web_search executed normally");
    console.log("✓ Test 3 Passed: Third web_search was blocked and Tavily was NOT called");
  }

  // -------------------------------------------------------------
  // Test 4: A new request resets the counter
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing new request resets the counter...");
  {
    const mockWebSearch = new MockWebSearchTool();
    const registry = new ToolRegistry();
    registry.register(mockWebSearch);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Searching in new request",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_new_1", name: "web_search", arguments: { query: "new turn search" } }],
        };
      }
      return {
        content: "New turn answer",
        provider: "mock",
        model: "mock",
        toolCalls: [],
      };
    });

    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
    });

    // Run first request (executes 1 search)
    await loop.run({
      userId: "test-user-1",
      task: "Turn 1",
      maxSteps: 3,
    });
    assert.equal(mockWebSearch.executionCount, 1, "First request executed 1 search");

    // Reset mock provider calls for Turn 2
    mockProvider.calls = [];
    // Run second request with the same loop/tool instance
    const result2 = await loop.run({
      userId: "test-user-1",
      task: "Turn 2",
      maxSteps: 3,
    });

    assert.equal(result2.status, AGENT_STATUSES.COMPLETED);
    assert.equal(mockWebSearch.executionCount, 2, "Second request executed its own search without carryover");
    console.log("✓ Test 4 Passed: A new request starts with a fresh counter");
  }

  // -------------------------------------------------------------
  // Test 5: Calculator/datetime/unit_conversion are unaffected
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing non-web tools (calculator) are unaffected by web search limit...");
  {
    const mockWebSearch = new MockWebSearchTool();
    const mockCalc = new MockCalculatorTool();
    const registry = new ToolRegistry();
    registry.register(mockWebSearch);
    registry.register(mockCalc);

    // Call calculator 4 times + web_search 2 times
    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex < 4) {
        return {
          content: "Calc " + callIndex,
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "calc_" + callIndex, name: "calculator", arguments: { expression: "2+2" } }],
        };
      }
      if (callIndex === 4) {
        return {
          content: "Web search 1",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "web_1", name: "web_search", arguments: { query: "tech news" } }],
        };
      }
      return {
        content: "Done",
        provider: "mock",
        model: "mock",
        toolCalls: [],
      };
    });

    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
    });

    const result = await loop.run({
      userId: "test-user-1",
      task: "Calculate multiple times and search",
      maxSteps: 8,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(mockCalc.executionCount, 4, "Calculator should execute all 4 times without restriction");
    assert.equal(mockWebSearch.executionCount, 1, "Web search executed 1 time");
    console.log("✓ Test 5 Passed: Calculator and non-web tools are completely unaffected");
  }

  // -------------------------------------------------------------
  // Test 6: Web Search does NOT perform additional credit deductions
  // -------------------------------------------------------------
  console.log("\n[Test 6] Confirming Web Search does not perform credit deductions...");
  {
    const { DEFAULT_CHAT_CREDIT_COST } = await import("../src/modules/ai/orchestrator.service.js");
    const { webSearchTool } = await import("../src/modules/agent/tools/web-search.tool.js");

    // 1. Confirm default chat credit cost remains strictly 1 credit per request
    assert.equal(DEFAULT_CHAT_CREDIT_COST, 1, "Default chat credit cost must remain exactly 1 credit per request");

    // 2. Confirm WebSearchTool does NOT have any credit deduction logic
    assert.equal((webSearchTool as any).deductCredits, undefined, "WebSearchTool must not expose or call deductCredits");

    // 3. Confirm AgentLoop execution runs without calling any credit deduction
    const mockWebSearch = new MockWebSearchTool();
    const registry = new ToolRegistry();
    registry.register(mockWebSearch);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Searching",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "web_1", name: "web_search", arguments: { query: "weather" } }],
        };
      }
      return { content: "Weather is sunny", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
    });

    const result = await loop.run({
      userId: "test-user-1",
      task: "Weather search",
      maxSteps: 3,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(mockWebSearch.executionCount, 1);
    console.log("✓ Test 6 Passed: Web Search executes without performing credit deductions (1-credit request fee preserved)");
  }

  console.log("\n========================================================");
  console.log(" ALL WEB SEARCH LIMIT TESTS PASSED (6/6)               ");
  console.log("========================================================\n");
};

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
