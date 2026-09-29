import "dotenv/config";
import assert from "node:assert/strict";
import {
  WebSearchTool,
  webSearchTool,
  registerWebSearchTool,
  DEFAULT_WEB_SEARCH_MAX_QUERY_LENGTH,
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_UNAVAILABLE_MESSAGE,
  type WebSearchInput,
} from "../src/modules/agent/tools/web-search.tool.js";
import { ToolRegistry, toolRegistry } from "../src/modules/agent/tool.registry.js";
import { toolExecutor } from "../src/modules/agent/tool.executor.js";
import type { ToolCall } from "../src/modules/agent/agent.types.js";

const runTests = async () => {
  console.log("=== Starting Agent Core: Web Search Tool Unit Tests ===");

  // -------------------------------------------------------------
  // Test 1: Tool Registration in ToolRegistry
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing tool registration in ToolRegistry...");
  assert.ok(
    toolRegistry.has("web_search"),
    "webSearchTool must be registered in default toolRegistry",
  );
  const registeredTool = toolRegistry.get("web_search");
  assert.ok(
    registeredTool instanceof WebSearchTool,
    "Registered tool must be an instance of WebSearchTool",
  );
  assert.equal(registeredTool.name, "web_search");
  assert.equal(registeredTool.schema.type, "object");
  assert.deepEqual(registeredTool.schema.required, ["query"]);

  const customRegistry = new ToolRegistry();
  registerWebSearchTool(customRegistry);
  assert.ok(
    customRegistry.has("web_search"),
    "Custom registry must register webSearchTool",
  );
  console.log("✓ WebSearchTool registration in toolRegistry verified");

  // -------------------------------------------------------------
  // Test 2: Intent Matching (matchesQuery)
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing query intent detection (matchesQuery)...");
  // 1. Required positive cases (must select Web Search path)
  assert.equal(webSearchTool.matchesQuery("What is the latest React version?"), true);
  assert.equal(webSearchTool.matchesQuery("Search the web for the latest Node.js release."), true);
  assert.equal(webSearchTool.matchesQuery("What happened in AI news today?"), true);
  assert.equal(webSearchTool.matchesQuery("current Node.js version"), true);
  assert.equal(webSearchTool.matchesQuery("what is the current price of Bitcoin?"), true);
  assert.equal(webSearchTool.matchesQuery("current price of Bitcoin"), true);
  assert.equal(webSearchTool.matchesQuery("search the web for quantum computing"), true);
  assert.equal(webSearchTool.matchesQuery("look up latest news on AI"), true);
  assert.equal(webSearchTool.matchesQuery("find recent information about generative models"), true);

  // Natural language current-information and weather cases
  assert.equal(webSearchTool.matchesQuery("What's the weather look like today in Shimla?"), true);
  assert.equal(webSearchTool.matchesQuery("How's the weather in Seattle tomorrow?"), true);
  assert.equal(webSearchTool.matchesQuery("Is it raining today in London?"), true);
  assert.equal(webSearchTool.matchesQuery("What is the weather forecast for Chicago?"), true);
  assert.equal(webSearchTool.matchesQuery("What's the current weather in Delhi?"), true);
  assert.equal(webSearchTool.matchesQuery("What's the weather in Shimla?"), true);
  assert.equal(webSearchTool.matchesQuery("How is the weather in Shimla?"), true);
  assert.equal(webSearchTool.matchesQuery("weather in Mumbai"), true);

  // 2. Required negative cases (ordinary informational or other tools; must NOT select Web Search)
  assert.equal(webSearchTool.matchesQuery("What is React?"), false);
  assert.equal(webSearchTool.matchesQuery("Explain React hooks."), false);
  assert.equal(webSearchTool.matchesQuery("What is a JavaScript closure?"), false);
  assert.equal(webSearchTool.matchesQuery("Explain JavaScript closures."), false);
  assert.equal(webSearchTool.matchesQuery("What is a REST API?"), false);
  assert.equal(webSearchTool.matchesQuery("What is JavaScript?"), false);
  assert.equal(webSearchTool.matchesQuery("Explain REST APIs."), false);
  assert.equal(webSearchTool.matchesQuery("How does a Promise work?"), false);
  assert.equal(webSearchTool.matchesQuery("What is a binary tree?"), false);
  assert.equal(webSearchTool.matchesQuery("what is 2 + 2"), false);
  assert.equal(webSearchTool.matchesQuery("Calculate 1542 * 38"), false);
  assert.equal(webSearchTool.matchesQuery("Calculate 1542 × 38."), false);
  assert.equal(webSearchTool.matchesQuery("What time is it?"), false);
  assert.equal(webSearchTool.matchesQuery("Convert 10 km to miles"), false);
  assert.equal(webSearchTool.matchesQuery("Convert 10 miles to kilometers."), false);
  console.log("✓ Query intent detection behaves as expected");

  // -------------------------------------------------------------
  // Test 3: Validation - Missing / Empty Query
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing validation of empty or invalid query...");
  const invalidInputRes = await webSearchTool.execute(null as unknown as WebSearchInput);
  assert.equal(invalidInputRes.isError, true);
  assert.ok(invalidInputRes.error?.includes("Input must contain a string 'query'"));

  const nonStringQueryRes = await webSearchTool.execute({ query: 123 as unknown as string });
  assert.equal(nonStringQueryRes.isError, true);
  assert.ok(nonStringQueryRes.error?.includes("Input must contain a string 'query'"));

  const emptyQueryRes = await webSearchTool.execute({ query: "" });
  assert.equal(emptyQueryRes.isError, true);
  assert.equal(emptyQueryRes.error, "Query cannot be empty");

  const whitespaceQueryRes = await webSearchTool.execute({ query: "    " });
  assert.equal(whitespaceQueryRes.isError, true);
  assert.equal(whitespaceQueryRes.error, "Query cannot be empty");
  console.log("✓ Empty and invalid queries safely rejected");

  // -------------------------------------------------------------
  // Test 4: Validation - Query Exceeding Max Length
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing validation of query exceeding maximum length...");
  const longQuery = "a".repeat(DEFAULT_WEB_SEARCH_MAX_QUERY_LENGTH + 1);
  const longQueryRes = await webSearchTool.execute({ query: longQuery });
  assert.equal(longQueryRes.isError, true);
  assert.ok(
    longQueryRes.error?.includes("Query exceeds maximum allowed length"),
    "Should reject query longer than max allowed length",
  );
  console.log("✓ Query exceeding maximum length safely rejected");

  // -------------------------------------------------------------
  // Test 5: Validation - Missing TAVILY_API_KEY
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing missing TAVILY_API_KEY handling...");
  const originalKey = process.env.TAVILY_API_KEY;
  try {
    delete process.env.TAVILY_API_KEY;
    const toolWithoutKey = new WebSearchTool({ apiKey: "" });
    const missingKeyRes = await toolWithoutKey.execute({ query: "TypeScript news" });
    assert.equal(missingKeyRes.isError, true);
    assert.equal(
      missingKeyRes.error,
      WEB_SEARCH_UNAVAILABLE_MESSAGE,
      "Should return user-neutral unavailable message",
    );
    assert.ok(
      !missingKeyRes.error?.includes("TAVILY_API_KEY"),
      "Must NOT expose TAVILY_API_KEY variable name",
    );
    assert.ok(
      !missingKeyRes.error?.includes("environment"),
      "Must NOT expose internal environment configuration details",
    );
    assert.ok(
      !missingKeyRes.error?.includes("key"),
      "Must NOT mention API key internals to the AI",
    );
  } finally {
    if (originalKey !== undefined) {
      process.env.TAVILY_API_KEY = originalKey;
    }
  }
  console.log("✓ Missing TAVILY_API_KEY returns user-neutral message without leaking config details");

  // -------------------------------------------------------------
  // Test 6: Valid Search Query with Mocked Tavily Response
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing valid search query with normalized results...");
  const mockFetchSuccess: typeof fetch = async (input, init) => {
    const reqBody = JSON.parse(init?.body as string);
    assert.equal(reqBody.query, "Node.js v22 features");
    assert.equal(reqBody.max_results, 5);

    return new Response(
      JSON.stringify({
        query: "Node.js v22 features",
        results: [
          {
            title: "Node.js v22 Released",
            url: "https://nodejs.org/en/blog/release/v22",
            content: "Node.js 22 is now available with V8 12.4 and WebSocket support.",
            score: 0.98,
          },
          {
            title: "What's new in Node 22",
            url: "https://example.com/node-22-overview",
            content: "A detailed breakdown of Node.js 22 new capabilities.",
            score: 0.89,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolWithSuccess = new WebSearchTool({
    apiKey: "test-tavily-key",
    fetchFn: mockFetchSuccess,
  });

  const successRes = await toolWithSuccess.execute({ query: "  Node.js v22 features  " });
  assert.equal(successRes.isError, false);
  assert.equal(successRes.output.query, "Node.js v22 features");
  assert.equal(successRes.output.totalResults, 2);
  assert.equal(successRes.output.results.length, 2);
  assert.deepEqual(successRes.output.results[0], {
    title: "Node.js v22 Released",
    url: "https://nodejs.org/en/blog/release/v22",
    content: "Node.js 22 is now available with V8 12.4 and WebSocket support.",
  });
  console.log("✓ Valid search produces normalized, trimmed results");

  // -------------------------------------------------------------
  // Test 7: Empty Search Results
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing empty search results handling...");
  const mockFetchEmpty: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        query: "qwertyuiopasdfghjklzxcvbnm1234567890",
        results: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolWithEmpty = new WebSearchTool({
    apiKey: "test-tavily-key",
    fetchFn: mockFetchEmpty,
  });

  const emptyRes = await toolWithEmpty.execute({
    query: "qwertyuiopasdfghjklzxcvbnm1234567890",
  });
  assert.equal(emptyRes.isError, false, "Empty results must return a valid tool result (not an error)");
  assert.equal(emptyRes.output.totalResults, 0);
  assert.deepEqual(emptyRes.output.results, []);
  assert.ok(emptyRes.output.message?.includes("No search results found"));
  console.log("✓ Empty search results return valid non-error result with 0 items");

  // -------------------------------------------------------------
  // Test 8: Tavily HTTP 401 (Unauthorized)
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing Tavily HTTP 401 Unauthorized handling...");
  const loggedWarns: any[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    loggedWarns.push(args);
  };

  try {
    const mockFetch401: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    };

    const toolWith401 = new WebSearchTool({
      apiKey: "secret-401-key",
      fetchFn: mockFetch401,
    });

    const res401 = await toolWith401.execute({ query: "AI agents" });
    assert.equal(res401.isError, true);
    assert.equal(res401.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
    assert.ok(!res401.error?.includes("secret-401-key"), "No API key leakage in tool result");
    assert.ok(!res401.error?.includes("Tavily"), "No provider name exposed to AI");

    // Verify server-side logging
    assert.ok(loggedWarns.length > 0, "Server warning must be logged for HTTP 401");
    const warnCall = loggedWarns.find((w) => w[0]?.includes("[WebSearchTool] Tavily API error"));
    assert.ok(warnCall, "Logged warning must tag [WebSearchTool]");
    assert.equal(warnCall[1]?.status, 401);
    assert.ok(!JSON.stringify(warnCall).includes("secret-401-key"), "Server log must not contain API key");
  } finally {
    console.warn = originalWarn;
  }
  console.log("✓ HTTP 401 returned safe user-neutral error and logged warning without secrets");

  // -------------------------------------------------------------
  // Test 9: Tavily HTTP 429 (Rate Limit / Quota Exceeded)
  // -------------------------------------------------------------
  console.log("\n[Test 9] Testing Tavily HTTP 429 Rate Limit handling...");
  loggedWarns.length = 0;
  console.warn = (...args: any[]) => {
    loggedWarns.push(args);
  };

  try {
    const mockFetch429: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: "Usage limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    };

    const toolWith429 = new WebSearchTool({
      apiKey: "secret-429-key",
      fetchFn: mockFetch429,
    });

    const res429 = await toolWith429.execute({ query: "AI agents" });
    assert.equal(res429.isError, true);
    assert.equal(res429.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
    assert.ok(!res429.error?.includes("secret-429-key"));

    const warnCall = loggedWarns.find((w) => w[0]?.includes("[WebSearchTool] Tavily API error"));
    assert.ok(warnCall, "Logged warning must tag [WebSearchTool]");
    assert.equal(warnCall[1]?.status, 429);
    assert.ok(!JSON.stringify(warnCall).includes("secret-429-key"));
  } finally {
    console.warn = originalWarn;
  }
  console.log("✓ HTTP 429 returned safe rate limit error and logged warning without secrets");

  // -------------------------------------------------------------
  // Test 10: Tavily HTTP 500 (Non-2xx Response)
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing Tavily HTTP 500 handling...");
  loggedWarns.length = 0;
  console.warn = (...args: any[]) => {
    loggedWarns.push(args);
  };

  try {
    const mockFetch500: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: "Internal Server Error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    };

    const toolWith500 = new WebSearchTool({
      apiKey: "secret-500-key",
      fetchFn: mockFetch500,
    });

    const res500 = await toolWith500.execute({ query: "AI agents" });
    assert.equal(res500.isError, true);
    assert.equal(res500.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
    assert.ok(!res500.error?.includes("secret-500-key"));

    const warnCall = loggedWarns.find((w) => w[0]?.includes("[WebSearchTool] Tavily API error"));
    assert.ok(warnCall);
    assert.equal(warnCall[1]?.status, 500);
    assert.ok(!JSON.stringify(warnCall).includes("secret-500-key"));
  } finally {
    console.warn = originalWarn;
  }
  console.log("✓ HTTP 500 returned safe user-neutral error and logged warning without secrets");

  // -------------------------------------------------------------
  // Test 11: Network Failure Handling with API-Key Redaction
  // -------------------------------------------------------------
  console.log("\n[Test 11] Testing network failure handling...");
  loggedWarns.length = 0;
  console.warn = (...args: any[]) => {
    loggedWarns.push(args);
  };

  try {
    const testSecretKey = "tvly-secret-alpha-99999";
    const mockFetchNetworkError: typeof fetch = async () => {
      throw new TypeError(`fetch failed to ${testSecretKey}: ECONNREFUSED`);
    };

    const toolWithNetError = new WebSearchTool({
      apiKey: testSecretKey,
      fetchFn: mockFetchNetworkError,
    });

    const netErrorRes = await toolWithNetError.execute({ query: "AI agents" });
    assert.equal(netErrorRes.isError, true);
    assert.equal(netErrorRes.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
    assert.ok(!netErrorRes.error?.includes(testSecretKey), "Tool result must not leak secret");

    // Verify server logging redacted the key
    const warnCall = loggedWarns.find((w) => w[0]?.includes("[WebSearchTool] Tavily request failed"));
    assert.ok(warnCall, "Server warning must log failed request");
    assert.ok(!JSON.stringify(warnCall).includes(testSecretKey), "Server log must redact the API key");
    assert.ok(JSON.stringify(warnCall).includes("[REDACTED]"), "Server log must contain [REDACTED]");
  } finally {
    console.warn = originalWarn;
  }
  console.log("✓ Network failure handled safely; API key redacted in server logs and hidden from AI");

  // -------------------------------------------------------------
  // Test 12: Timeout Handling
  // -------------------------------------------------------------
  console.log("\n[Test 12] Testing timeout handling...");
  loggedWarns.length = 0;
  console.warn = (...args: any[]) => {
    loggedWarns.push(args);
  };

  try {
    const mockFetchTimeout: typeof fetch = async (_input, init) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("Request aborted"));
        });
      });
    };

    const toolWithTimeout = new WebSearchTool({
      apiKey: "test-tavily-key",
      timeoutMs: 50, // Short timeout for test
      fetchFn: mockFetchTimeout,
    });

    const timeoutRes = await toolWithTimeout.execute({ query: "AI agents" });
    assert.equal(timeoutRes.isError, true);
    assert.equal(timeoutRes.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);

    const warnCall = loggedWarns.find((w) => w[0]?.includes("[WebSearchTool] Tavily request failed"));
    assert.ok(warnCall);
    assert.equal(warnCall[1]?.reason, "timeout");
  } finally {
    console.warn = originalWarn;
  }
  console.log("✓ Request timeout handled safely and logged warning with reason");

  // -------------------------------------------------------------
  // Test 13: Execution Through ToolExecutor
  // -------------------------------------------------------------
  console.log("\n[Test 13] Testing execution through ToolExecutor...");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetchSuccess;
    process.env.TAVILY_API_KEY = "test-tavily-key";

    const toolCall: ToolCall = {
      id: "call_web_search_1",
      name: "web_search",
      arguments: {
        query: "Node.js v22 features",
      },
    };

    const execRes = await toolExecutor.execute(toolCall);
    assert.equal(execRes.toolCallId, "call_web_search_1");
    assert.equal(execRes.toolName, "web_search");
    assert.equal(execRes.isError, false);
    assert.equal((execRes.output as any)?.totalResults, 2);
    assert.ok(typeof execRes.durationMs === "number" && execRes.durationMs >= 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env.TAVILY_API_KEY = originalKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  }
  console.log("✓ Execution through ToolExecutor produced normalized ToolCallResult");

  // -------------------------------------------------------------
  // Test 14: Application Startup Path Registration
  // -------------------------------------------------------------
  console.log("\n[Test 14] Testing application startup path registration...");
  const appModule = await import("../src/app.js");
  assert.ok(appModule.default, "app.js must export default express app");
  assert.ok(
    toolRegistry.has("web_search"),
    "web_search must be present in toolRegistry upon application startup",
  );
  assert.equal(toolRegistry.get("web_search")?.name, "web_search");
  console.log("✓ Application startup path loads and registers web_search in ToolRegistry");

  // -------------------------------------------------------------
  // Test 15: Results Capped Using maxResults
  // -------------------------------------------------------------
  console.log("\n[Test 15] Testing results capped using maxResults...");
  const mockFetchManyResults: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        query: "test query",
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i + 1}`,
          url: `https://example.com/${i + 1}`,
          content: `Content ${i + 1}`,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolWithCappedResults = new WebSearchTool({
    apiKey: "test-tavily-key",
    maxResults: 3,
    fetchFn: mockFetchManyResults,
  });

  const cappedRes = await toolWithCappedResults.execute({ query: "test query" });
  assert.equal(cappedRes.isError, false);
  assert.equal(cappedRes.output.results.length, 3, "Results must strictly be capped at maxResults (3)");
  assert.equal(cappedRes.output.totalResults, 3);
  console.log("✓ Results strictly capped at maxResults");

  // -------------------------------------------------------------
  // Test 16: TAVILY_API_KEY is Never Logged or Leaked in Errors
  // -------------------------------------------------------------
  console.log("\n[Test 16] Testing TAVILY_API_KEY is redacted in error messages...");
  const secretKey = "tvly-secret-prod-key-123456789";
  const mockFetchLeakingKey: typeof fetch = async () => {
    throw new Error(`Failed to authenticate with key ${secretKey} at host`);
  };

  const toolWithLeakingKey = new WebSearchTool({
    apiKey: secretKey,
    fetchFn: mockFetchLeakingKey,
  });

  const loggedWarns16: any[] = [];
  const originalWarn16 = console.warn;
  console.warn = (...args: any[]) => {
    loggedWarns16.push(args);
  };

  try {
    const redactedRes = await toolWithLeakingKey.execute({ query: "AI news" });
    assert.equal(redactedRes.isError, true);
    assert.equal(redactedRes.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
    assert.ok(!redactedRes.error?.includes(secretKey), "Error must not contain raw secret key");

    const warnCall = loggedWarns16.find((w) => w[0]?.includes("[WebSearchTool] Tavily request failed"));
    assert.ok(warnCall, "Server warning must log failed request");
    assert.ok(!JSON.stringify(warnCall).includes(secretKey), "Server log must not contain raw secret key");
    assert.ok(JSON.stringify(warnCall).includes("[REDACTED]"), "Secret key must be redacted in server log");
  } finally {
    console.warn = originalWarn16;
  }
  console.log("✓ TAVILY_API_KEY strictly redacted from server logs and user-neutral error returned to AI");

  // -------------------------------------------------------------
  // Test 17: Upstream Invalid JSON Response Handled Safely
  // -------------------------------------------------------------
  console.log("\n[Test 17] Testing upstream invalid JSON response handling...");
  const mockFetchInvalidJson: typeof fetch = async () => {
    return new Response("<html5>Gateway Timeout</html5>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const toolWithInvalidJson = new WebSearchTool({
    apiKey: "test-tavily-key",
    fetchFn: mockFetchInvalidJson,
  });

  const invalidJsonRes = await toolWithInvalidJson.execute({ query: "AI news" });
  assert.equal(invalidJsonRes.isError, true);
  assert.equal(invalidJsonRes.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
  console.log("✓ Invalid JSON response safely handled with user-neutral tool error");

  // -------------------------------------------------------------
  // Test 18: Safe Handling of Null and Non-Object Items in Results
  // -------------------------------------------------------------
  console.log("\n[Test 18] Testing safe handling of null/malformed items in results...");
  const mockFetchMalformedItems: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        query: "malformed items",
        results: [
          null,
          undefined,
          "invalid string item",
          42,
          { title: "Valid Item", url: "https://example.com/valid", content: "Valid" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolWithMalformedItems = new WebSearchTool({
    apiKey: "test-tavily-key",
    fetchFn: mockFetchMalformedItems,
  });

  const malformedItemsRes = await toolWithMalformedItems.execute({ query: "malformed items" });
  assert.equal(malformedItemsRes.isError, false);
  assert.equal(malformedItemsRes.output.results.length, 1);
  assert.equal(malformedItemsRes.output.results[0]?.title, "Valid Item");
  console.log("✓ Null/non-object items in results safely filtered without errors");

  // -------------------------------------------------------------
  // Test 19: isValidWebUrl Validation
  // -------------------------------------------------------------
  console.log("\n[Test 19] Testing isValidWebUrl security validation...");
  const { isValidWebUrl } = await import("../src/modules/agent/tools/web-search.tool.js");
  assert.equal(isValidWebUrl("https://react.dev"), true);
  assert.equal(isValidWebUrl("http://nodejs.org/en/blog"), true);
  assert.equal(isValidWebUrl("javascript:alert(1)"), false);
  assert.equal(isValidWebUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isValidWebUrl("file:///etc/passwd"), false);
  assert.equal(isValidWebUrl("/relative/path"), false);
  assert.equal(isValidWebUrl("not a url"), false);
  assert.equal(isValidWebUrl(""), false);
  assert.equal(isValidWebUrl(null), false);
  assert.equal(isValidWebUrl(undefined), false);
  console.log("✓ isValidWebUrl permits only http/https and strictly rejects dangerous schemes");

  // -------------------------------------------------------------
  // Test 20: Unsafe / Invalid URLs Filtered Out from Results
  // -------------------------------------------------------------
  console.log("\n[Test 20] Testing unsafe/invalid URLs filtered out from search results...");
  const mockFetchUnsafeUrls: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        query: "security test",
        results: [
          { title: "Safe HTTPS", url: "https://example.com/safe", content: "Safe" },
          { title: "Safe HTTP", url: "http://example.com/http", content: "HTTP" },
          { title: "XSS Attempt", url: "javascript:evil()", content: "Dangerous" },
          { title: "Data Scheme", url: "data:text/plain;base64,SGVsbG8=", content: "Dangerous" },
          { title: "Relative Path", url: "/local/file", content: "Invalid" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolWithUnsafeUrls = new WebSearchTool({
    apiKey: "test-tavily-key",
    fetchFn: mockFetchUnsafeUrls,
  });

  const unsafeUrlsRes = await toolWithUnsafeUrls.execute({ query: "security test" });
  assert.equal(unsafeUrlsRes.isError, false);
  assert.equal(unsafeUrlsRes.output.results.length, 2, "Only the 2 valid http/https URLs must be included");
  assert.equal(unsafeUrlsRes.output.results[0]?.url, "https://example.com/safe");
  assert.equal(unsafeUrlsRes.output.results[1]?.url, "http://example.com/http");
  console.log("✓ Unsafe/malicious URL schemes strictly filtered out from search results");

  console.log("\n==================================================");
  console.log(" ALL WEB SEARCH TOOL UNIT TESTS PASSED (20/20)    ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("Web Search Tool Tests Failed:", err);
  process.exit(1);
});
