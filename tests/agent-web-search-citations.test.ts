import assert from "node:assert/strict";
import {
  AgentLoop,
  ToolRegistry,
  ToolExecutor,
  formatWebSearchResultsForAI,
  AGENT_STATUSES,
  type AgentExecutionInput,
  type AgentStreamCallbacks,
} from "../src/modules/agent/index.js";
import { WEB_SEARCH_CITATION_INSTRUCTIONS } from "../src/modules/ai/prompts/system.prompt.js";
import type {
  AIMessage,
  AIProvider,
  AIResponse,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";
import type { Tool, ToolCallResult } from "../src/modules/agent/tool.interface.js";
import type { WebSearchOutput } from "../src/modules/agent/tools/web-search.tool.js";

/**
 * Controllable Mock AI Provider for testing citation propagation in AgentLoop.
 */
class ControllableMockProvider implements AIProvider {
  public readonly name = "mock_citation_provider";
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

const runTests = async () => {
  console.log("=== Starting Web Search Inline Citation Unit & Integration Tests ===");

  // -------------------------------------------------------------
  // Test 1: formatWebSearchResultsForAI deterministically indexes [1], [2], [3]
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing formatWebSearchResultsForAI source indexing [1], [2], [3]...");
  {
    const sampleOutput: WebSearchOutput = {
      query: "react 19 features",
      results: [
        {
          title: "React v19 is now available",
          url: "https://react.dev/blog/2024/12/05/react-19",
          content: "React 19 brings Actions, useOptimistic, and Server Components.",
        },
        {
          title: "React Documentation",
          url: "https://react.dev/reference/react",
          content: "Reference documentation for React APIs.",
        },
        {
          title: "NPM React Package",
          url: "https://www.npmjs.com/package/react",
          content: "Official npm package for React.",
        },
      ],
      totalResults: 3,
    };

    const formatted = formatWebSearchResultsForAI(sampleOutput);

    // Verify 1-based indices
    assert.ok(formatted.includes("[WEB SOURCES]"), "Must include [WEB SOURCES] header");
    assert.ok(formatted.includes("[1] React v19 is now available"), "Must index source 1 as [1]");
    assert.ok(formatted.includes("URL: https://react.dev/blog/2024/12/05/react-19"), "Must include URL for source 1");
    assert.ok(formatted.includes("Content: React 19 brings Actions"), "Must include Content for source 1");

    assert.ok(formatted.includes("[2] React Documentation"), "Must index source 2 as [2]");
    assert.ok(formatted.includes("URL: https://react.dev/reference/react"), "Must include URL for source 2");

    assert.ok(formatted.includes("[3] NPM React Package"), "Must index source 3 as [3]");
    assert.ok(formatted.includes("URL: https://www.npmjs.com/package/react"), "Must include URL for source 3");

    // Verify order is deterministic: [1] before [2] before [3]
    const idx1 = formatted.indexOf("[1]");
    const idx2 = formatted.indexOf("[2]");
    const idx3 = formatted.indexOf("[3]");
    assert.ok(idx1 < idx2 && idx2 < idx3, "Indices must be strictly in ascending order [1] < [2] < [3]");

    console.log("✓ formatWebSearchResultsForAI deterministically produces 1-based indexed sources");
  }

  // -------------------------------------------------------------
  // Test 2: Citation instructions are present in formatted web search output
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing citation instructions presence and content...");
  {
    const sampleOutput: WebSearchOutput = {
      query: "node 22",
      results: [
        {
          title: "Node.js 22 Announcement",
          url: "https://nodejs.org/en/blog/release/v22.0.0",
          content: "Node.js 22 is released with WebSocket enabled by default.",
        },
      ],
      totalResults: 1,
    };

    const formatted = formatWebSearchResultsForAI(sampleOutput);

    // Check all 7 key rules from Requirement 4
    assert.ok(
      formatted.includes("When web search results are available, use citation markers [1], [2], etc."),
      "Must instruct to use citation markers [1], [2]",
    );
    assert.ok(
      formatted.includes("Citation numbers must correspond exactly to the indexed search results."),
      "Must instruct exact correspondence",
    );
    assert.ok(
      formatted.includes("Never invent a citation number."),
      "Must instruct never to invent citation numbers",
    );
    assert.ok(
      formatted.includes("Do not cite a source that does not support the claim."),
      "Must instruct not to cite unsupported claims",
    );
    assert.ok(
      formatted.includes("If the available search results do not support a claim, say so instead of fabricating a citation."),
      "Must instruct saying so instead of fabricating",
    );
    assert.ok(
      formatted.includes("Do not add citations to unrelated normal-chat responses."),
      "Must instruct not to add citations to unrelated chat",
    );
    assert.ok(
      formatted.includes("Keep citations concise and readable."),
      "Must instruct keeping citations concise and readable",
    );

    console.log("✓ All explicit citation instructions are present in formatted output");
  }

  // -------------------------------------------------------------
  // Test 3: formatWebSearchResultsForAI filters invalid URLs and duplicate URLs
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing URL validation and deduplication in indexed output...");
  {
    const messyOutput = {
      query: "security test",
      results: [
        { title: "Safe 1", url: "https://safe.example.com/1", content: "Good" },
        { title: "Malicious", url: "javascript:alert(1)", content: "XSS" },
        { title: "Safe 1 Duplicate", url: "https://safe.example.com/1", content: "Duplicate URL" },
        { title: "Safe 2", url: "https://safe.example.com/2", content: "Second good" },
      ],
      totalResults: 4,
    };

    const formatted = formatWebSearchResultsForAI(messyOutput);

    assert.ok(formatted.includes("[1] Safe 1"), "First valid result is [1]");
    assert.ok(formatted.includes("[2] Safe 2"), "Second unique valid result is [2]");
    assert.ok(!formatted.includes("javascript:alert(1)"), "Unsafe protocol strictly omitted");
    assert.ok(!formatted.includes("[3]"), "Duplicate URL omitted, count remains 2");

    console.log("✓ Invalid and duplicate URLs safely filtered while preserving continuous 1-based indexing");
  }

  // -------------------------------------------------------------
  // Test 4: AgentLoop injects indexed sources & instructions on web_search tool call
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing AgentLoop end-to-end web_search execution and citation injection...");
  {
    const mockWebSearchTool: Tool = {
      name: "web_search",
      description: "Search the web",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: async (): Promise<ToolCallResult> => ({
        output: {
          query: "latest react version",
          results: [
            {
              title: "React 19 Blog",
              url: "https://react.dev/blog/2024/12/05/react-19",
              content: "React 19 was released in Dec 2024.",
            },
            {
              title: "React GitHub",
              url: "https://github.com/facebook/react",
              content: "The library for web and native user interfaces.",
            },
          ],
          totalResults: 2,
        },
        isError: false,
      }),
    };

    const registry = new ToolRegistry();
    registry.register(mockWebSearchTool);

    let emittedSources: any[] = [];
    const callbacks: AgentStreamCallbacks = {
      onSources: (sources) => {
        emittedSources = sources;
      },
    };

    const provider = new ControllableMockProvider(async (messages, callIndex) => {
      if (callIndex === 0) {
        // Step 1: Model requests web_search
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          toolCalls: [
            {
              id: "call_web_1",
              name: "web_search",
              arguments: { query: "latest react version" },
            },
          ],
        };
      }
      // Step 2: Model returns answer citing sources
      return {
        content: "React 19 was released in late 2024 [1], and is maintained on GitHub [2].",
        provider: "mock",
        model: "mock-model",
      };
    });

    const loop = new AgentLoop({ provider, registry });
    const result = await loop.run(
      { userId: "u1", task: "What is the latest React version?" },
      { callbacks },
    );

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(provider.calls.length, 2, "Loop executed 2 turns (tool call + final answer)");

    // Inspect the messages sent to the model on the second turn
    const secondCallMessages = provider.calls[1].messages;

    // Check system prompt was augmented with citation instructions
    const systemMsg = secondCallMessages.find((m) => m.role === "system");
    assert.ok(systemMsg, "System message must exist");
    assert.ok(
      systemMsg.content.includes("Web Search Citation Instructions"),
      "System message must receive Web Search Citation Instructions after web search",
    );

    // Check tool message contains [WEB SOURCES], [1], [2], and instructions
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "Tool message must exist");
    assert.ok(toolMsg.content.includes("[WEB SOURCES]"), "Tool message must have [WEB SOURCES] block");
    assert.ok(toolMsg.content.includes("[1] React 19 Blog"), "Tool message must index [1]");
    assert.ok(toolMsg.content.includes("[2] React GitHub"), "Tool message must index [2]");
    assert.ok(
      toolMsg.content.includes("Web Search Citation Instructions"),
      "Tool message must contain citation instructions",
    );

    // Check emitted sources remain { type: 'web', title, url }
    assert.equal(emittedSources.length, 2, "Emitted 2 sources via callback");
    assert.deepEqual(emittedSources[0], {
      type: "web",
      title: "React 19 Blog",
      url: "https://react.dev/blog/2024/12/05/react-19",
    });
    assert.deepEqual(emittedSources[1], {
      type: "web",
      title: "React GitHub",
      url: "https://github.com/facebook/react",
    });

    // Check toolCalls in result object preserves structured WebSearchOutput
    assert.equal(result.toolCalls.length, 1);
    const tcResult = result.toolCalls[0].result as WebSearchOutput;
    assert.equal(tcResult.query, "latest react version");
    assert.equal(tcResult.results.length, 2);
    assert.equal(tcResult.totalResults, 2);

    console.log("✓ AgentLoop correctly injected indexed sources and citation instructions without breaking source objects");
  }

  // -------------------------------------------------------------
  // Test 5: Normal non-web tool calls (e.g. calculator) do NOT receive web citation instructions
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing non-web tool calls (calculator) do NOT receive web citation instructions...");
  {
    const mockCalculatorTool: Tool = {
      name: "calculator",
      description: "Perform math",
      parameters: { type: "object", properties: { expression: { type: "string" } } },
      execute: async (): Promise<ToolCallResult> => ({
        output: 58596,
        isError: false,
      }),
    };

    const registry = new ToolRegistry();
    registry.register(mockCalculatorTool);

    const provider = new ControllableMockProvider(async (messages, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          toolCalls: [
            {
              id: "call_calc_1",
              name: "calculator",
              arguments: { expression: "1542 * 38" },
            },
          ],
        };
      }
      return {
        content: "The answer is 58596.",
        provider: "mock",
        model: "mock-model",
      };
    });

    const loop = new AgentLoop({ provider, registry });
    const result = await loop.run({
      userId: "u1",
      task: "Calculate 1542 * 38",
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    assert.equal(provider.calls.length, 2);

    const secondCallMessages = provider.calls[1].messages;

    // Check system prompt does NOT contain web citation instructions
    const systemMsg = secondCallMessages.find((m) => m.role === "system");
    assert.ok(
      !systemMsg?.content.includes("Web Search Citation Instructions"),
      "System message for calculator must NOT receive web citation instructions",
    );

    // Check tool message does NOT contain web citation instructions or [WEB SOURCES]
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "Tool message exists");
    assert.ok(
      !toolMsg.content.includes("[WEB SOURCES]"),
      "Calculator tool message must NOT contain [WEB SOURCES]",
    );
    assert.ok(
      !toolMsg.content.includes("Web Search Citation Instructions"),
      "Calculator tool message must NOT contain Web Search Citation Instructions",
    );

    console.log("✓ Non-web tool calls cleanly bypass web citation instructions");
  }

  // -------------------------------------------------------------
  // Test 6: Normal chat without tools does NOT receive web citation instructions
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing normal conversation without tools does NOT receive web citation instructions...");
  {
    const registry = new ToolRegistry();
    const provider = new ControllableMockProvider(async () => ({
      content: "Hello! How can I help you today?",
      provider: "mock",
      model: "mock-model",
    }));

    const loop = new AgentLoop({ provider, registry });
    const result = await loop.run({
      userId: "u1",
      task: "Hello",
    });

    assert.equal(result.status, AGENT_STATUSES.COMPLETED);
    const messages = provider.calls[0].messages;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(
      !systemMsg?.content.includes("Web Search Citation Instructions"),
      "Normal chat system message must NOT contain web citation instructions",
    );

    console.log("✓ Normal non-tool chat does NOT receive web citation instructions");
  }

  console.log("\n========================================================");
  console.log(" ALL WEB SEARCH INLINE CITATION TESTS PASSED (6/6)     ");
  console.log("========================================================\n");
};

runTests().catch((err) => {
  console.error("Web Search Citation Tests Failed:", err);
  process.exit(1);
});
