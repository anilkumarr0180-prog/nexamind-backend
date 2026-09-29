import "dotenv/config";
import assert from "node:assert/strict";

// CRITICAL: We intentionally do NOT import web-search.tool.ts, calculator.tool.ts,
// datetime.tool.ts, or unit-conversion.tool.ts directly in this test file.
// We only import the application root and the ToolRegistry to verify
// that the application's actual startup path loads and registers the tools.
import app from "../src/app.js";
import { toolRegistry } from "../src/modules/agent/tool.registry.js";

const runTests = async () => {
  console.log("=== Starting Agent Tool Loading: Startup Flow Verification Tests ===");

  // -------------------------------------------------------------
  // Test 1: Verify express application initialization
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing express app startup initialization...");
  assert.ok(app, "Express app instance must exist");
  assert.equal(typeof app.listen, "function", "App must be an Express application");
  console.log("✓ Application root (src/app.js) loaded cleanly");

  // -------------------------------------------------------------
  // Test 2: Verify all 4 tools are registered via application startup path
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing that normal application startup registered all agent tools...");
  const registeredNames = toolRegistry.list().map((t) => t.name);
  console.log("Registered tools at runtime:", registeredNames);

  assert.ok(
    toolRegistry.has("calculator"),
    "'calculator' tool must be loaded and registered by the application startup path",
  );
  assert.ok(
    toolRegistry.has("datetime"),
    "'datetime' tool must be loaded and registered by the application startup path",
  );
  assert.ok(
    toolRegistry.has("unit_conversion"),
    "'unit_conversion' tool must be loaded and registered by the application startup path",
  );
  assert.ok(
    toolRegistry.has("web_search"),
    "'web_search' tool must be loaded and registered by the application startup path",
  );
  console.log("✓ All 4 tools are registered into ToolRegistry via the startup dependency graph");

  // -------------------------------------------------------------
  // Test 3: Inspect web_search tool contract from runtime ToolRegistry
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing web_search tool structure resolved from ToolRegistry...");
  const webSearchTool = toolRegistry.get("web_search");
  assert.ok(webSearchTool, "web_search tool must be retrievable from ToolRegistry");
  assert.equal(webSearchTool.name, "web_search");
  assert.ok(webSearchTool.description.length > 0, "Tool description must be present");
  assert.equal(webSearchTool.schema.type, "object");
  assert.deepEqual(webSearchTool.schema.required, ["query"]);
  assert.equal(typeof webSearchTool.execute, "function", "Tool must implement execute()");
  assert.equal(typeof webSearchTool.matchesQuery, "function", "Tool must implement matchesQuery()");
  console.log("✓ web_search tool adheres to AgentTool contract in runtime registry");

  console.log("\n==================================================");
  console.log(" ALL STARTUP TOOL LOADING TESTS PASSED (3/3)       ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("Startup Tool Loading Tests Failed:", err);
  process.exit(1);
});
