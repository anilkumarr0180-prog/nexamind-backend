import assert from "node:assert/strict";
import {
  ToolRegistry,
  ToolExecutor,
  executeToolCall,
  type AgentTool,
  type ToolCall,
} from "../src/modules/agent/index.js";

const runTests = async () => {
  console.log("=== Starting Agent Core: Tool Executor Unit Tests ===");

  const registry = new ToolRegistry();
  const executor = new ToolExecutor(registry);

  // -------------------------------------------------------------
  // Test 1: Successful Tool Execution
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing successful tool execution...");
  const mockEchoTool: AgentTool<{ message: string }, { echo: string }> = {
    name: "echo_tool",
    description: "Echoes input message",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
    execute: async (input) => {
      return {
        output: { echo: input.message },
        isError: false,
      };
    },
  };

  registry.register(mockEchoTool);

  const call1: ToolCall = {
    id: "call_echo_1",
    name: "echo_tool",
    arguments: { message: "hello world" },
  };

  const res1 = await executor.execute(call1, { userId: "user_test_1" });
  assert.equal(res1.toolCallId, "call_echo_1");
  assert.equal(res1.toolName, "echo_tool");
  assert.equal(res1.isError, false);
  assert.equal(res1.error, undefined);
  assert.deepEqual(res1.output, { echo: "hello world" });
  assert.ok(typeof res1.durationMs === "number" && res1.durationMs >= 0);
  console.log("✓ Successful tool execution verified with accurate output and timing");

  // -------------------------------------------------------------
  // Test 2: Unknown Tool Handling
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing unknown / unregistered tool handling...");
  const callUnknown: ToolCall = {
    id: "call_unknown_1",
    name: "nonexistent_calculator",
    arguments: { expr: "2 + 2" },
  };

  const resUnknown = await executor.execute(callUnknown);
  assert.equal(resUnknown.toolCallId, "call_unknown_1");
  assert.equal(resUnknown.toolName, "nonexistent_calculator");
  assert.equal(resUnknown.isError, true);
  assert.equal(resUnknown.output, null);
  assert.ok(
    resUnknown.error?.includes('Tool "nonexistent_calculator" is not registered'),
    `Error must clearly indicate unregistered tool: ${resUnknown.error}`,
  );
  assert.ok(typeof resUnknown.durationMs === "number" && resUnknown.durationMs >= 0);
  console.log("✓ Unknown tool cleanly returns controlled error result without throwing");

  // -------------------------------------------------------------
  // Test 3: Tool Execution Failure Handling
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing tool execution failure handling (exception thrown)...");
  const mockFailingTool: AgentTool = {
    name: "failing_tool",
    description: "Always throws an unhandled error",
    schema: { type: "object" },
    execute: async () => {
      throw new Error("Simulated external API network outage");
    },
  };

  registry.register(mockFailingTool);

  const callFailing: ToolCall = {
    id: "call_fail_1",
    name: "failing_tool",
    arguments: {},
  };

  const resFailing = await executor.execute(callFailing);
  assert.equal(resFailing.toolCallId, "call_fail_1");
  assert.equal(resFailing.toolName, "failing_tool");
  assert.equal(resFailing.isError, true);
  assert.equal(resFailing.output, null);
  assert.ok(
    resFailing.error?.includes("Simulated external API network outage"),
    `Error message must be captured: ${resFailing.error}`,
  );
  assert.ok(typeof resFailing.durationMs === "number" && resFailing.durationMs >= 0);
  console.log("✓ Tool exception caught safely and converted to isError=true result");

  // -------------------------------------------------------------
  // Test 4: Execution Duration and Result Normalization
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing execution duration and result normalization...");

  // 4a. Tool with elapsed execution duration
  const mockDelayedTool: AgentTool = {
    name: "delayed_tool",
    description: "Simulates work delay",
    schema: { type: "object" },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {
        output: "delayed result",
        isError: false,
      };
    },
  };

  registry.register(mockDelayedTool);

  const callDelayed: ToolCall = {
    id: "call_delayed_1",
    name: "delayed_tool",
    arguments: {},
  };

  const resDelayed = await executor.execute(callDelayed);
  assert.equal(resDelayed.toolCallId, "call_delayed_1");
  assert.equal(resDelayed.toolName, "delayed_tool");
  assert.equal(resDelayed.isError, false);
  assert.equal(resDelayed.output, "delayed result");
  assert.ok(
    resDelayed.durationMs !== undefined && resDelayed.durationMs >= 20,
    `Duration must measure elapsed time: ${resDelayed.durationMs}ms`,
  );

  // 4b. Tool returning raw primitive output (normalized)
  const mockRawTool: AgentTool = {
    name: "raw_value_tool",
    description: "Returns raw number without envelope",
    schema: { type: "object" },
    execute: async () => {
      return 12345 as any;
    },
  };

  registry.register(mockRawTool);

  const callRaw: ToolCall = {
    id: "call_raw_1",
    name: "raw_value_tool",
    arguments: {},
  };

  const resRaw = await executor.execute(callRaw);
  assert.equal(resRaw.toolCallId, "call_raw_1");
  assert.equal(resRaw.toolName, "raw_value_tool");
  assert.equal(resRaw.isError, false);
  assert.equal(resRaw.output, 12345);
  assert.ok(typeof resRaw.durationMs === "number");

  // 4c. Tool returning explicit failure status without throwing
  const mockControlledFailTool: AgentTool = {
    name: "controlled_fail_tool",
    description: "Returns isError=true envelope without throwing",
    schema: { type: "object" },
    execute: async () => {
      return {
        output: null,
        isError: true,
        error: "Item not found in third-party database",
      };
    },
  };

  registry.register(mockControlledFailTool);

  const callControlledFail: ToolCall = {
    id: "call_ctrl_1",
    name: "controlled_fail_tool",
    arguments: {},
  };

  const resControlledFail = await executor.execute(callControlledFail);
  assert.equal(resControlledFail.toolCallId, "call_ctrl_1");
  assert.equal(resControlledFail.toolName, "controlled_fail_tool");
  assert.equal(resControlledFail.isError, true);
  assert.equal(resControlledFail.error, "Item not found in third-party database");
  assert.equal(resControlledFail.output, null);

  // 4d. executeToolCall standalone helper
  const resHelper = await executeToolCall(call1, undefined, registry);
  assert.equal(resHelper.toolCallId, "call_echo_1");
  assert.equal(resHelper.isError, false);

  console.log("✓ Duration measurement and result normalization verified across all formats");

  console.log("\n==================================================");
  console.log(" ALL AGENT TOOL EXECUTOR UNIT TESTS PASSED (4/4)  ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("Agent Tool Executor Unit Tests Failed:", err);
  process.exit(1);
});
