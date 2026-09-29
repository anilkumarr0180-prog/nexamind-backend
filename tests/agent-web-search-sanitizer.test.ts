import "dotenv/config";
import assert from "node:assert/strict";
import {
  WebSearchTool,
  sanitizeWebSearchQuery,
  type WebSearchResultItem,
} from "../src/modules/agent/tools/web-search.tool.js";

const runTests = async () => {
  console.log("=== Starting Web Search Query Sanitizer & Integration Tests ===");

  // -------------------------------------------------------------
  // Test 1-4: Queries that SHOULD normalize
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing leading wrapper: Please search the web for...");
  assert.equal(
    sanitizeWebSearchQuery("Please search the web for the latest React version"),
    "the latest React version",
    "Should strip leading please search the web for",
  );
  console.log("✓ Test 1 Passed: Leading wrapper stripped");

  console.log("\n[Test 2] Testing leading wrapper: Search online for...");
  assert.equal(
    sanitizeWebSearchQuery("Search online for latest React version"),
    "latest React version",
    "Should strip leading search online for",
  );
  console.log("✓ Test 2 Passed: Search online for stripped");

  console.log("\n[Test 3] Testing trailing AI instructions: Search the web and cite your sources...");
  assert.equal(
    sanitizeWebSearchQuery("  What is the latest React version?   Search the web and cite your sources.  "),
    "What is the latest React version?",
    "Should strip trailing search and citation instructions",
  );
  console.log("✓ Test 3 Passed: Trailing AI instructions stripped while preserving query");

  console.log("\n[Test 4] Testing multiple spaces and newlines collapsing...");
  assert.equal(
    sanitizeWebSearchQuery("latest   React\n\nversion"),
    "latest React version",
    "Should collapse internal whitespace and newlines to a single space",
  );
  console.log("✓ Test 4 Passed: Multiple spaces/newlines collapsed");

  // -------------------------------------------------------------
  // Test 5-9: Queries that MUST preserve meaning
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing preservation: How do search engines rank React documentation?...");
  assert.equal(
    sanitizeWebSearchQuery("How do search engines rank React documentation?"),
    "How do search engines rank React documentation?",
  );
  console.log("✓ Test 5 Passed: Search engine question preserved intact");

  console.log("\n[Test 6] Testing preservation: What is Google Search Console?...");
  assert.equal(
    sanitizeWebSearchQuery("What is Google Search Console?"),
    "What is Google Search Console?",
  );
  console.log("✓ Test 6 Passed: Google Search Console preserved intact");

  console.log("\n[Test 7] Testing preservation: Search engine optimization for React...");
  assert.equal(
    sanitizeWebSearchQuery("Search engine optimization for React"),
    "Search engine optimization for React",
  );
  console.log("✓ Test 7 Passed: SEO query preserved intact");

  console.log("\n[Test 8] Testing preservation: How does web search work?...");
  assert.equal(
    sanitizeWebSearchQuery("How does web search work?"),
    "How does web search work?",
  );
  console.log("✓ Test 8 Passed: Web search mechanics query preserved intact");

  console.log("\n[Test 9] Testing preservation: Find out how React Server Components work...");
  assert.equal(
    sanitizeWebSearchQuery("Find out how React Server Components work"),
    "Find out how React Server Components work",
  );
  console.log("✓ Test 9 Passed: Technical research query preserved intact");

  // -------------------------------------------------------------
  // Test 10: Empty result fallback
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing empty sanitizer result fallback to original trimmed query...");
  assert.equal(
    sanitizeWebSearchQuery("Please search the web"),
    "Please search the web",
    "Should fallback to raw trimmed query when sanitization would leave empty string",
  );
  console.log("✓ Test 10 Passed: Empty result fallback preserved");

  // -------------------------------------------------------------
  // Additional Edge Cases
  // -------------------------------------------------------------
  console.log("\n[Test 11] Additional variations (Google ..., Look up ..., trailing with comma)...");
  assert.equal(
    sanitizeWebSearchQuery("Look up the latest React version"),
    "the latest React version",
  );
  assert.equal(
    sanitizeWebSearchQuery("Google the latest React version"),
    "the latest React version",
  );
  assert.equal(
    sanitizeWebSearchQuery("Latest React version, please search online and provide sources."),
    "Latest React version",
  );
  console.log("✓ Test 11 Passed: Additional safe wrappers normalized");

  // -------------------------------------------------------------
  // Test 12: Integration Test - Sanitized query sent to Tavily
  // -------------------------------------------------------------
  console.log("\n[Test 12] Integration Test: Tavily receives sanitized query, original preserved in result...");
  let capturedTavilyBody: any = null;
  const mockFetch: typeof fetch = async (input, init) => {
    capturedTavilyBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        query: capturedTavilyBody.query,
        results: [
          {
            title: "React v19 Release",
            url: "https://react.dev/blog/2024/12/05/react-19",
            content: "React 19 released.",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const rawUserQuery = "What is the latest React version? Search the web and cite your sources.";
  const tool = new WebSearchTool({
    apiKey: "test-api-key",
    fetchFn: mockFetch,
    disableCache: true,
  });

  const executionResult = await tool.execute({ query: rawUserQuery });
  assert.equal(executionResult.isError, false);

  // Assert what Tavily received
  assert.ok(capturedTavilyBody, "Tavily request must be made");
  assert.equal(
    capturedTavilyBody.query,
    "What is the latest React version?",
    "Tavily must receive the sanitized query without conversational wrappers",
  );

  // Assert tool execution output retains the caller query
  assert.equal(
    executionResult.output.query,
    rawUserQuery.trim(),
    "Tool execution result should retain the original caller query",
  );
  console.log("✓ Test 12 Passed: Tavily received sanitized query, tool result preserved caller query");

  // -------------------------------------------------------------
  // Test 13: Deduplication across conversational variations
  // -------------------------------------------------------------
  console.log("\n[Test 13] Testing deduplication between conversational variation and raw query...");
  let tavilyCallCount = 0;
  const mockFetchCounter: typeof fetch = async (_input, init) => {
    tavilyCallCount++;
    const body = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        query: body.query,
        results: [
          {
            title: "React 19 Official",
            url: "https://react.dev",
            content: "React 19 is live.",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const cachingTool = new WebSearchTool({
    apiKey: "test-api-key",
    fetchFn: mockFetchCounter,
  });

  // Call 1 with conversational wrapper
  const res1 = await cachingTool.execute({
    query: "Please search online for latest React version",
  });
  assert.equal(res1.isError, false);
  assert.equal(tavilyCallCount, 1, "First search should invoke Tavily");

  // Call 2 with direct query that normalizes to the same sanitized query
  const res2 = await cachingTool.execute({
    query: "latest React version",
  });
  assert.equal(res2.isError, false);
  assert.equal(
    tavilyCallCount,
    1,
    "Second search must hit cache and NOT trigger a duplicate Tavily API call",
  );
  assert.deepEqual(res2.output.results, res1.output.results);
  console.log("✓ Test 13 Passed: Deduplication prevented duplicate Tavily API request across conversational variations");

  console.log("\n========================================================");
  console.log(" ALL SANITIZER & INTEGRATION TESTS PASSED (13/13)       ");
  console.log("========================================================");
};

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
