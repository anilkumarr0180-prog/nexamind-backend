import assert from "node:assert/strict";
import {
  DateTimeTool,
  dateTimeTool,
  registerDateTimeTool,
} from "../src/modules/agent/tools/datetime.tool.js";
import { ToolRegistry, toolRegistry } from "../src/modules/agent/tool.registry.js";
import { ToolExecutor, toolExecutor } from "../src/modules/agent/tool.executor.js";
import type { ToolCall } from "../src/modules/agent/agent.types.js";

const runTests = async () => {
  console.log("=== Starting Agent Core: DateTime Tool Unit Tests ===");

  // -------------------------------------------------------------
  // Test 1: Tool Registration
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing tool registration in ToolRegistry...");
  assert.ok(toolRegistry.has("datetime"), "dateTimeTool must be registered in default toolRegistry");
  assert.ok(toolRegistry.get("datetime") instanceof DateTimeTool, "Tool must be instance of DateTimeTool");

  const customRegistry = new ToolRegistry();
  registerDateTimeTool(customRegistry);
  assert.ok(customRegistry.has("datetime"), "Custom registry must register dateTimeTool");
  console.log("✓ DateTime tool registration in toolRegistry verified");

  // -------------------------------------------------------------
  // Test 2: Default Timezone Execution (UTC)
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing default timezone execution (UTC)...");
  const defaultRes = await dateTimeTool.execute({});
  assert.equal(defaultRes.isError, false, "Default execution must succeed without error");
  assert.equal(defaultRes.output.timezone, "UTC");
  assert.ok(defaultRes.output.iso.endsWith("Z") || defaultRes.output.iso.includes("+00:00"));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(defaultRes.output.date), "Date must be YYYY-MM-DD");
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(defaultRes.output.time), "Time must be HH:MM:SS");
  assert.ok(typeof defaultRes.output.dayOfWeek === "string" && defaultRes.output.dayOfWeek.length > 0);
  assert.ok(typeof defaultRes.output.timestamp === "number" && defaultRes.output.timestamp > 0);
  console.log("✓ Default UTC execution produces structured date/time output");

  // -------------------------------------------------------------
  // Test 3: Explicit Timezone: Asia/Kolkata
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing explicit timezone Asia/Kolkata...");
  const kolkataRes = await dateTimeTool.execute({ timezone: "Asia/Kolkata" });
  assert.equal(kolkataRes.isError, false);
  assert.equal(kolkataRes.output.timezone, "Asia/Kolkata");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(kolkataRes.output.date));
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(kolkataRes.output.time));
  assert.ok(kolkataRes.output.formatted.includes("GMT+5:30") || kolkataRes.output.formatted.includes("IST") || kolkataRes.output.formatted.includes("India"));
  console.log("✓ Asia/Kolkata timezone evaluated accurately with local offset");

  // -------------------------------------------------------------
  // Test 4: Explicit Timezone: Europe/London & America/New_York
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing Europe/London and America/New_York timezones...");
  const londonRes = await dateTimeTool.execute({ timezone: "Europe/London" });
  assert.equal(londonRes.isError, false);
  assert.equal(londonRes.output.timezone, "Europe/London");

  const nyRes = await dateTimeTool.execute({ timezone: "America/New_York" });
  assert.equal(nyRes.isError, false);
  assert.equal(nyRes.output.timezone, "America/New_York");
  console.log("✓ Europe/London and America/New_York timezones evaluated accurately");

  // -------------------------------------------------------------
  // Test 5: Timezone Alias Resolution
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing informal timezone aliases...");
  const aliasIndia = await dateTimeTool.execute({ timezone: "india" });
  assert.equal(aliasIndia.isError, false);
  assert.equal(aliasIndia.output.timezone, "Asia/Kolkata");

  const aliasLondon = await dateTimeTool.execute({ timezone: "london" });
  assert.equal(aliasLondon.isError, false);
  assert.equal(aliasLondon.output.timezone, "Europe/London");

  const aliasNY = await dateTimeTool.execute({ timezone: "new_york" });
  assert.equal(aliasNY.isError, false);
  assert.equal(aliasNY.output.timezone, "America/New_York");
  console.log("✓ Informal timezone aliases safely resolved to canonical IANA names");

  // -------------------------------------------------------------
  // Test 6: Invalid / Unsupported Timezone Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing invalid timezone handling...");
  const invalidRes = await dateTimeTool.execute({ timezone: "Mars/Olympus_Mons" });
  assert.equal(invalidRes.isError, true, "Invalid timezone must yield isError: true");
  assert.equal(invalidRes.output, null);
  assert.ok(invalidRes.error?.includes("Invalid or unsupported timezone"), "Error must describe invalid timezone");

  const unsafeRes = await dateTimeTool.execute({ timezone: "'; DROP TABLE users; --" });
  assert.equal(unsafeRes.isError, true);
  assert.equal(unsafeRes.output, null);
  console.log("✓ Invalid and unsafe timezones safely rejected with controlled error");

  // -------------------------------------------------------------
  // Test 7: Query Intent Matching (matchesQuery)
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing query intent detection (matchesQuery)...");
  const positiveQueries = [
    "What time is it?",
    "What is today's date?",
    "What is the current date and time?",
    "What day is today?",
    "What time is it in India?",
    "What time is it in London?",
    "What date is it in New York?",
    "What time is it in Asia/Kolkata?",
    "Tell me the current time",
    "What is the date today?",
  ];

  for (const q of positiveQueries) {
    assert.equal(dateTimeTool.matchesQuery(q), true, `Query "${q}" should match dateTimeTool`);
  }

  const negativeQueries = [
    "What is JavaScript?",
    "Tell me a joke",
    "Explain quantum computing in simple terms",
    "Write a python script to reverse a string",
    "Calculate 1542 * 38",
    "How do I cook pasta?",
  ];

  for (const q of negativeQueries) {
    assert.equal(dateTimeTool.matchesQuery(q), false, `Query "${q}" should NOT match dateTimeTool`);
  }
  console.log("✓ Query intent detection accurately matches date/time requests and rejects non-temporal queries");

  // -------------------------------------------------------------
  // Test 8: End-to-End ToolExecutor Execution
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing execution through ToolExecutor...");
  const callDateTime: ToolCall = {
    id: "call_dt_e2e_1",
    name: "datetime",
    arguments: { timezone: "Asia/Kolkata" },
  };

  const execRes = await toolExecutor.execute(callDateTime);
  assert.equal(execRes.toolCallId, "call_dt_e2e_1");
  assert.equal(execRes.toolName, "datetime");
  assert.equal(execRes.isError, false);
  assert.equal((execRes.output as any)?.timezone, "Asia/Kolkata");
  assert.ok(typeof execRes.durationMs === "number" && execRes.durationMs >= 0);
  console.log("✓ Execution through ToolExecutor produced normalized ToolCallResult");

  console.log("\n==================================================");
  console.log(" ALL DATETIME TOOL UNIT TESTS PASSED (8/8)       ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("DateTime Tool Unit Tests Failed:", err);
  process.exit(1);
});
