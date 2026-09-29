import assert from "node:assert/strict";
import {
  AgentLoop,
  ToolRegistry,
  MAX_WEB_SEARCHES_PER_REQUEST,
  normalizeWebSearchQuery,
  AGENT_STATUSES,
} from "../src/modules/agent/index.js";
import type {
  AIMessage,
  AIProvider,
  AIResponse,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "../src/modules/agent/tool.interface.js";

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
 * Mock WebSearchTool tracking actual tool executions (simulating Tavily API calls).
 */
class MockTavilySearchTool implements AgentTool {
  public readonly name = "web_search";
  public readonly description = "Mock Tavily web search";
  public readonly schema = { type: "object", properties: { query: { type: "string" } } };
  public executionCount = 0;
  public executedQueries: string[] = [];
  public shouldFailQuery: string | null = null;

  async execute(
    input: { query: string },
    _context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executionCount++;
    this.executedQueries.push(input?.query ?? "");

    if (this.shouldFailQuery && input?.query === this.shouldFailQuery) {
      return {
        output: null,
        isError: true,
        error: "Tavily search network timeout",
      };
    }

    return {
      output: {
        query: input.query,
        results: [
          {
            title: "Result for " + input.query,
            url: "https://example.com/" + encodeURIComponent(input.query.trim().toLowerCase()),
            content: "Snippet content for " + input.query,
          },
        ],
        totalResults: 1,
      },
      isError: false,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Web Search In-Request Deduplication Tests ===");

  // -------------------------------------------------------------
  // Test 1: Same exact query twice -> only one Tavily call
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing same exact query twice -> only 1 Tavily call...");
  {
    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "1st search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "latest react version" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "2nd search (duplicate)",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_2", name: "web_search", arguments: { query: "latest react version" } }],
        };
      }
      return {
        content: "Final answer based on React version.",
        provider: "mock",
        model: "mock",
        toolCalls: [],
      };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run({
      userId: "user-1",
      task: "Lookup React version twice",
      maxSteps: 5,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    // Two tool calls recorded in state
    assert.equal(result.toolCalls.length, 2, "Agent recorded 2 tool calls");
    // But Tavily tool was only contacted once!
    assert.equal(mockTool.executionCount, 1, "Tavily was contacted exactly ONCE");
    assert.deepEqual(mockTool.executedQueries, ["latest react version"]);

    // Both tool calls produced the valid result
    const call1Result = result.toolCalls[0]!.result as any;
    const call2Result = result.toolCalls[1]!.result as any;
    assert.equal(call1Result.query, "latest react version");
    assert.equal(call2Result.query, "latest react version");
    assert.equal(call2Result.results[0].title, call1Result.results[0].title);

    console.log("✓ Test 1 Passed: Same exact query executed Tavily only once, reused result on 2nd call");
  }

  // -------------------------------------------------------------
  // Test 2: Same query with different casing/whitespace -> only one Tavily call
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing different casing and whitespace normalization...");
  {
    assert.equal(normalizeWebSearchQuery("Latest React version"), "latest react version");
    assert.equal(normalizeWebSearchQuery("  latest   react   version  "), "latest react version");
    assert.equal(normalizeWebSearchQuery("LATEST REACT VERSION"), "latest react version");

    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "1st search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "Latest React version" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "2nd search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_2", name: "web_search", arguments: { query: "  latest   react   version  " } }],
        };
      }
      if (callIndex === 2) {
        return {
          content: "3rd search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_3", name: "web_search", arguments: { query: "LATEST REACT VERSION" } }],
        };
      }
      return { content: "Done", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run({
      userId: "user-1",
      task: "Test casing deduplication",
      maxSteps: 6,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(result.toolCalls.length, 3, "All 3 tool calls recorded");
    assert.equal(mockTool.executionCount, 1, "Tavily was contacted only ONCE despite 3 casing/whitespace variations");
    console.log("✓ Test 2 Passed: Casing and whitespace normalized; only 1 Tavily call made");
  }

  // -------------------------------------------------------------
  // Test 3: Different queries -> separate Tavily calls
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing different queries perform separate Tavily calls...");
  {
    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Search React",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "latest React version" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "Search Node",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_2", name: "web_search", arguments: { query: "latest Node.js version" } }],
        };
      }
      return { content: "Done", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run({
      userId: "user-1",
      task: "Search different topics",
      maxSteps: 5,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(mockTool.executionCount, 2, "Both distinct queries made separate Tavily calls");
    assert.equal(mockTool.executedQueries[0], "latest React version");
    assert.equal(mockTool.executedQueries[1], "latest Node.js version");
    console.log("✓ Test 3 Passed: Distinct queries execute separate searches");
  }

  // -------------------------------------------------------------
  // Test 4: Failed first search -> identical retry is allowed
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing failed first search allows identical retry...");
  {
    const mockTool = new MockTavilySearchTool();
    // Simulate first attempt failing
    mockTool.shouldFailQuery = "flakey query";
    const registry = new ToolRegistry();
    registry.register(mockTool);

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Attempt 1",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_fail", name: "web_search", arguments: { query: "flakey query" } }],
        };
      }
      if (callIndex === 1) {
        // Clear failure so retry succeeds
        mockTool.shouldFailQuery = null;
        return {
          content: "Attempt 2 (retry identical query)",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "call_retry", name: "web_search", arguments: { query: "flakey query" } }],
        };
      }
      return { content: "Recovered", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run({
      userId: "user-1",
      task: "Test retry on error",
      maxSteps: 5,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    // Tool was executed twice because the first attempt failed and was NOT cached
    assert.equal(mockTool.executionCount, 2, "Tavily was contacted twice to retry the failed query");
    assert.equal(result.toolCalls[0]!.status, "ERROR");
    assert.equal(result.toolCalls[1]!.status, "SUCCESS");
    console.log("✓ Test 4 Passed: Failed search was not cached, identical retry was allowed");
  }

  // -------------------------------------------------------------
  // Test 5: Duplicate search still preserves the original web sources
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing duplicate search preserves original web sources and citations...");
  {
    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    let sourcesEvents: any[] = [];

    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "1st search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c1", name: "web_search", arguments: { query: "react 19 release" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "Duplicate search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c2", name: "web_search", arguments: { query: "react 19 release" } }],
        };
      }
      return { content: "Done [1]", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run(
      {
        userId: "user-1",
        task: "Source preservation test",
        maxSteps: 5,
      },
      {
        callbacks: {
          onSources: (sources) => {
            sourcesEvents.push(JSON.parse(JSON.stringify(sources)));
          },
        },
      }
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(mockTool.executionCount, 1, "Tavily called only once");

    // Check that source events contain valid web source
    assert.ok(sourcesEvents.length >= 1, "Sources emitted");
    const firstEmitted = sourcesEvents[0][0];
    assert.equal(firstEmitted.type, "web");
    assert.ok(firstEmitted.url.includes("react%2019%20release"));

    // Check message history has proper formatted source results
    const toolMsg2 = result.toolCalls[1];
    assert.ok(toolMsg2);
    const out2 = toolMsg2.result as any;
    assert.equal(out2.results[0].url, firstEmitted.url);

    console.log("✓ Test 5 Passed: Original web sources preserved across duplicate search calls");
  }

  // -------------------------------------------------------------
  // Test 6: Existing maximum 2-search-per-request limit still works
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing sequence: Search 1 -> Search 1 (dup) -> Search 2 -> Search 3 (blocked)...");
  {
    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    // Call 0: Query A (fresh -> Tavily call 1)
    // Call 1: Query A (dup -> reused -> 0 Tavily calls)
    // Call 2: Query B (fresh -> Tavily call 2)
    // Call 3: Query C (fresh -> blocked by MAX_WEB_SEARCHES_PER_REQUEST = 2)
    const mockProvider = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Search A",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c1", name: "web_search", arguments: { query: "query A" } }],
        };
      }
      if (callIndex === 1) {
        return {
          content: "Search A again (dup)",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c2", name: "web_search", arguments: { query: "query A" } }],
        };
      }
      if (callIndex === 2) {
        return {
          content: "Search B",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c3", name: "web_search", arguments: { query: "query B" } }],
        };
      }
      if (callIndex === 3) {
        return {
          content: "Search C",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "c4", name: "web_search", arguments: { query: "query C" } }],
        };
      }
      return { content: "Final Answer", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: mockProvider, registry });
    const result = await loop.run({
      userId: "user-1",
      task: "Test sequence with duplicate and limit",
      maxSteps: 8,
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    // Total 4 tool calls attempted in the conversation
    assert.equal(result.toolCalls.length, 4);

    // Tavily was called exactly twice (for Query A and Query B)
    assert.equal(mockTool.executionCount, 2, "Tavily was contacted exactly 2 times");
    assert.deepEqual(mockTool.executedQueries, ["query A", "query B"]);

    // Tool call 2 (Query A duplicate) was successful from cache
    assert.equal(result.toolCalls[1]!.status, "SUCCESS");

    // Tool call 4 (Query C) was blocked by the max 2 searches limit
    assert.equal(
      result.toolCalls[3]!.result,
      "Maximum web search limit reached for this turn. Use the search results already retrieved to answer the user."
    );

    console.log("✓ Test 6 Passed: Search 1 -> Search 1 (dup) -> Search 2 -> Search 3 (blocked) worked as required");
  }

  // -------------------------------------------------------------
  // Test 7: New AI request starts with a fresh deduplication state
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing new AI request starts with a fresh deduplication state...");
  {
    const mockTool = new MockTavilySearchTool();
    const registry = new ToolRegistry();
    registry.register(mockTool);

    // Request 1 searches "same query"
    const provider1 = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Turn 1 search",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "t1", name: "web_search", arguments: { query: "common query" } }],
        };
      }
      return { content: "Turn 1 done", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop = new AgentLoop({ provider: provider1, registry });
    await loop.run({ userId: "user-1", task: "Turn 1", maxSteps: 3 });
    assert.equal(mockTool.executionCount, 1, "Turn 1 executed Tavily call");

    // Request 2 searches "same query" again in a new turn
    const provider2 = new ControllableMockProvider((_messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "Turn 2 search (same query)",
          provider: "mock",
          model: "mock",
          toolCalls: [{ id: "t2", name: "web_search", arguments: { query: "common query" } }],
        };
      }
      return { content: "Turn 2 done", provider: "mock", model: "mock", toolCalls: [] };
    });

    const loop2 = new AgentLoop({ provider: provider2, registry });
    await loop2.run({ userId: "user-1", task: "Turn 2", maxSteps: 3 });

    // Turn 2 executed its own fresh Tavily call because cache is per-request
    assert.equal(mockTool.executionCount, 2, "Turn 2 executed a fresh Tavily call (fresh per-request state)");
    console.log("✓ Test 7 Passed: Cache is request-scoped; new request starts with fresh deduplication state");
  }

  console.log("\n========================================================");
  console.log(" ALL 7 DEDUPLICATION SCENARIOS PASSED (7/7)            ");
  console.log("========================================================\n");
};

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
