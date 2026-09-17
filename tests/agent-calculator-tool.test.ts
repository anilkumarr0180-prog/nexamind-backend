import assert from "node:assert/strict";
import {
  calculatorTool,
  toolRegistry,
  toolExecutor,
  type ToolCall,
} from "../src/modules/agent/index.js";

const runTests = async () => {
  console.log("=== Starting Agent Core: Calculator Tool Unit Tests ===");

  // Verification that tool is registered in toolRegistry
  assert.ok(
    toolRegistry.has("calculator"),
    "Calculator tool must be automatically registered in toolRegistry",
  );
  assert.equal(toolRegistry.get("calculator")?.name, "calculator");
  console.log("✓ Calculator tool registration in toolRegistry verified");

  // -------------------------------------------------------------
  // Test 1: Addition
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing addition...");
  const addRes1 = await calculatorTool.execute({ expression: "15 + 27" });
  assert.equal(addRes1.isError, false);
  assert.equal(addRes1.output.result, 42);

  const addRes2 = await calculatorTool.execute({ expression: "1.5 + 2.25 + 0.25" });
  assert.equal(addRes2.isError, false);
  assert.equal(addRes2.output.result, 4);
  console.log("✓ Addition (integer & decimal) evaluated correctly");

  // -------------------------------------------------------------
  // Test 2: Subtraction
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing subtraction...");
  const subRes1 = await calculatorTool.execute({ expression: "100 - 42" });
  assert.equal(subRes1.isError, false);
  assert.equal(subRes1.output.result, 58);

  const subRes2 = await calculatorTool.execute({ expression: "10 - 25" });
  assert.equal(subRes2.isError, false);
  assert.equal(subRes2.output.result, -15);
  console.log("✓ Subtraction (positive & negative results) evaluated correctly");

  // -------------------------------------------------------------
  // Test 3: Multiplication
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing multiplication...");
  const mulRes1 = await calculatorTool.execute({ expression: "6 * 7" });
  assert.equal(mulRes1.isError, false);
  assert.equal(mulRes1.output.result, 42);

  const mulRes2 = await calculatorTool.execute({ expression: "5 * -3" });
  assert.equal(mulRes2.isError, false);
  assert.equal(mulRes2.output.result, -15);
  console.log("✓ Multiplication (including unary negative operands) evaluated correctly");

  // -------------------------------------------------------------
  // Test 4: Division
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing division...");
  const divRes1 = await calculatorTool.execute({ expression: "100 / 4" });
  assert.equal(divRes1.isError, false);
  assert.equal(divRes1.output.result, 25);

  const divRes2 = await calculatorTool.execute({ expression: "7 / 2" });
  assert.equal(divRes2.isError, false);
  assert.equal(divRes2.output.result, 3.5);
  console.log("✓ Division evaluated correctly");

  // -------------------------------------------------------------
  // Test 5: Percentage / Modulo
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing percentage/modulo (%)...");
  const modRes1 = await calculatorTool.execute({ expression: "10 % 3" });
  assert.equal(modRes1.isError, false);
  assert.equal(modRes1.output.result, 1);

  const modRes2 = await calculatorTool.execute({ expression: "25 % 7" });
  assert.equal(modRes2.isError, false);
  assert.equal(modRes2.output.result, 4);
  console.log("✓ Percentage/modulo (%) evaluated correctly");

  // -------------------------------------------------------------
  // Test 6: Parentheses & Complex Precedence
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing parentheses and operator precedence...");
  const parenRes1 = await calculatorTool.execute({ expression: "(2 + 3) * (4 + 1)" });
  assert.equal(parenRes1.isError, false);
  assert.equal(parenRes1.output.result, 25);

  const parenRes2 = await calculatorTool.execute({
    expression: "((10 - 2) * (3 + 1)) / 2",
  });
  assert.equal(parenRes2.isError, false);
  assert.equal(parenRes2.output.result, 16);

  const precedenceRes = await calculatorTool.execute({ expression: "2 + 3 * 4" });
  assert.equal(precedenceRes.isError, false);
  assert.equal(precedenceRes.output.result, 14, "Multiplication must precede addition");
  console.log("✓ Parentheses grouping and standard precedence evaluated correctly");

  // -------------------------------------------------------------
  // Test 7: Invalid Expressions
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing invalid expressions...");
  const emptyRes = await calculatorTool.execute({ expression: "" });
  assert.equal(emptyRes.isError, true);
  assert.ok(emptyRes.error?.includes("cannot be empty"));

  const unclosedParenRes = await calculatorTool.execute({ expression: "(2 + 3" });
  assert.equal(unclosedParenRes.isError, true);
  assert.ok(unclosedParenRes.error?.includes("Mismatched parentheses"));

  const extraCloseParenRes = await calculatorTool.execute({ expression: "2 + 3)" });
  assert.equal(extraCloseParenRes.isError, true);
  assert.ok(extraCloseParenRes.error?.includes("Unexpected"));

  const trailingOpRes = await calculatorTool.execute({ expression: "5 +" });
  assert.equal(trailingOpRes.isError, true);
  assert.ok(trailingOpRes.error?.includes("Unexpected end of expression"));

  const doubleDotRes = await calculatorTool.execute({ expression: "1.2.3 + 4" });
  assert.equal(doubleDotRes.isError, true);
  assert.ok(doubleDotRes.error?.includes("multiple decimal points"));
  console.log("✓ Malformed and invalid expressions rejected with controlled error messages");

  // -------------------------------------------------------------
  // Test 8: Division by Zero
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing division by zero...");
  const divZeroRes = await calculatorTool.execute({ expression: "100 / 0" });
  assert.equal(divZeroRes.isError, true);
  assert.equal(divZeroRes.output, null);
  assert.ok(
    divZeroRes.error?.toLowerCase().includes("division by zero"),
    `Error must mention division by zero: ${divZeroRes.error}`,
  );

  const modZeroRes = await calculatorTool.execute({ expression: "100 % 0" });
  assert.equal(modZeroRes.isError, true);
  assert.equal(modZeroRes.output, null);
  assert.ok(
    modZeroRes.error?.toLowerCase().includes("zero"),
    `Error must mention zero: ${modZeroRes.error}`,
  );
  console.log("✓ Division and modulo by zero handled with controlled tool error without throwing");

  // -------------------------------------------------------------
  // Test 9: Unsafe Input Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 9] Testing unsafe input rejection...");
  const unsafeInputs = [
    'eval("2 + 2")',
    "Function('return 2+2')()",
    "process.exit(1)",
    "<script>alert(1)</script>",
    "__proto__.polluted = true",
    "require('fs')",
    "import('os')",
    "2 + 2; console.log(1)",
    "`${2+2}`",
  ];

  for (const unsafe of unsafeInputs) {
    const res = await calculatorTool.execute({ expression: unsafe });
    assert.equal(res.isError, true, `Unsafe input "${unsafe}" must be rejected`);
    assert.equal(res.output, null);
    assert.ok(
      res.error?.includes("invalid or unsafe characters"),
      `Error must reject unsafe characters: ${res.error}`,
    );
  }
  console.log("✓ Dynamic code injection and unsafe characters strictly rejected");

  // -------------------------------------------------------------
  // Test 10: End-to-End ToolExecutor Execution
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing execution through ToolExecutor...");
  const callCalc: ToolCall = {
    id: "call_calc_e2e_1",
    name: "calculator",
    arguments: { expression: "(100 - 20) / 4 + 7 * 3" },
  };

  const execRes = await toolExecutor.execute(callCalc);
  assert.equal(execRes.toolCallId, "call_calc_e2e_1");
  assert.equal(execRes.toolName, "calculator");
  assert.equal(execRes.isError, false);
  assert.equal((execRes.output as any)?.result, 41); // (80 / 4) + 21 = 20 + 21 = 41
  assert.ok(typeof execRes.durationMs === "number" && execRes.durationMs >= 0);
  console.log("✓ End-to-end execution through ToolExecutor produced normalized ToolCallResult");

  console.log("\n==================================================");
  console.log(" ALL CALCULATOR TOOL UNIT TESTS PASSED (10/10)   ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("Calculator Tool Unit Tests Failed:", err);
  process.exit(1);
});
