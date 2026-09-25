import "dotenv/config";
import "../src/modules/agent/tools/calculator.tool.js";
import "../src/modules/agent/tools/datetime.tool.js";
import assert from "node:assert/strict";
import {
  UnitConversionTool,
  unitConversionTool,
  registerUnitConversionTool,
} from "../src/modules/agent/tools/unit-conversion.tool.js";
import { ToolRegistry, toolRegistry } from "../src/modules/agent/tool.registry.js";
import { ToolExecutor, toolExecutor } from "../src/modules/agent/tool.executor.js";
import type { ToolCall } from "../src/modules/agent/agent.types.js";

const runTests = async () => {
  console.log("=== Starting Agent Core: Unit Conversion Tool Unit Tests ===");

  // -------------------------------------------------------------
  // Test 1: Tool Registration & Presence in Registry
  // -------------------------------------------------------------
  console.log("\n[Test 1] Testing tool registration in ToolRegistry...");
  assert.ok(toolRegistry.has("unit_conversion"), "unitConversionTool must be registered in default toolRegistry");
  assert.ok(toolRegistry.get("unit_conversion") instanceof UnitConversionTool, "Tool must be instance of UnitConversionTool");

  // Registry must contain calculator, datetime, and unit_conversion
  assert.ok(toolRegistry.has("calculator"), "calculator must be registered");
  assert.ok(toolRegistry.has("datetime"), "datetime must be registered");
  assert.ok(toolRegistry.has("unit_conversion"), "unit_conversion must be registered");

  const customRegistry = new ToolRegistry();
  registerUnitConversionTool(customRegistry);
  assert.ok(customRegistry.has("unit_conversion"), "Custom registry must register unitConversionTool");
  console.log("✓ UnitConversionTool registration in toolRegistry verified");

  // -------------------------------------------------------------
  // Test 2: Length: Kilometer → Mile
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing Kilometer → Mile conversion...");
  const kmToMiRes = await unitConversionTool.execute({
    value: 10,
    fromUnit: "kilometer",
    toUnit: "mile",
  });
  assert.equal(kmToMiRes.isError, false);
  assert.equal(kmToMiRes.output.value, 10);
  assert.equal(kmToMiRes.output.fromUnit, "kilometer");
  assert.equal(kmToMiRes.output.toUnit, "mile");
  assert.equal(kmToMiRes.output.category, "length");
  // 10000 m / 1609.344 m = 6.213712
  assert.equal(kmToMiRes.output.result, 6.213712);
  assert.ok(kmToMiRes.output.formatted.includes("10 kilometer = 6.213712 mile"));
  console.log("✓ Kilometer → Mile conversion accurate (10 km = 6.213712 mi)");

  // -------------------------------------------------------------
  // Test 3: Length: Meter → Foot
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing Meter → Foot conversion...");
  const mToFtRes = await unitConversionTool.execute({
    value: 2,
    fromUnit: "meter",
    toUnit: "foot",
  });
  assert.equal(mToFtRes.isError, false);
  // 2 m / 0.3048 m = 6.56168
  assert.equal(mToFtRes.output.result, 6.56168);
  console.log("✓ Meter → Foot conversion accurate (2 m = 6.56168 ft)");

  // -------------------------------------------------------------
  // Test 4: Mass: Kilogram → Pound
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing Kilogram → Pound conversion...");
  const kgToLbRes = await unitConversionTool.execute({
    value: 5,
    fromUnit: "kilogram",
    toUnit: "pound",
  });
  assert.equal(kgToLbRes.isError, false);
  assert.equal(kgToLbRes.output.category, "mass");
  // 5000 g / 453.59237 g = 11.023113
  assert.equal(kgToLbRes.output.result, 11.023113);
  console.log("✓ Kilogram → Pound conversion accurate (5 kg = 11.023113 lb)");

  // -------------------------------------------------------------
  // Test 5: Mass: Gram → Kilogram
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing Gram → Kilogram conversion...");
  const gToKgRes = await unitConversionTool.execute({
    value: 500,
    fromUnit: "gram",
    toUnit: "kilogram",
  });
  assert.equal(gToKgRes.isError, false);
  assert.equal(gToKgRes.output.result, 0.5);
  console.log("✓ Gram → Kilogram conversion accurate (500 g = 0.5 kg)");

  // -------------------------------------------------------------
  // Test 6: Temperature: Celsius → Fahrenheit
  // -------------------------------------------------------------
  console.log("\n[Test 6] Testing Celsius → Fahrenheit conversion...");
  const cToFRes1 = await unitConversionTool.execute({
    value: 100,
    fromUnit: "celsius",
    toUnit: "fahrenheit",
  });
  assert.equal(cToFRes1.isError, false);
  assert.equal(cToFRes1.output.result, 212);

  const cToFRes0 = await unitConversionTool.execute({
    value: 0,
    fromUnit: "celsius",
    toUnit: "fahrenheit",
  });
  assert.equal(cToFRes0.isError, false);
  assert.equal(cToFRes0.output.result, 32);
  console.log("✓ Celsius → Fahrenheit conversion accurate (0 C = 32 F, 100 C = 212 F)");

  // -------------------------------------------------------------
  // Test 7: Temperature: Fahrenheit → Celsius
  // -------------------------------------------------------------
  console.log("\n[Test 7] Testing Fahrenheit → Celsius conversion...");
  const fToCRes = await unitConversionTool.execute({
    value: 100,
    fromUnit: "fahrenheit",
    toUnit: "celsius",
  });
  assert.equal(fToCRes.isError, false);
  // (100 - 32) * 5/9 = 37.777778
  assert.equal(fToCRes.output.result, 37.777778);
  console.log("✓ Fahrenheit → Celsius conversion accurate (100 F = 37.777778 C)");

  // -------------------------------------------------------------
  // Test 8: Temperature: Celsius → Kelvin
  // -------------------------------------------------------------
  console.log("\n[Test 8] Testing Celsius → Kelvin conversion...");
  const cToKRes = await unitConversionTool.execute({
    value: 0,
    fromUnit: "celsius",
    toUnit: "kelvin",
  });
  assert.equal(cToKRes.isError, false);
  assert.equal(cToKRes.output.result, 273.15);
  console.log("✓ Celsius → Kelvin conversion accurate (0 C = 273.15 K)");

  // -------------------------------------------------------------
  // Test 9: Temperature: Kelvin → Celsius
  // -------------------------------------------------------------
  console.log("\n[Test 9] Testing Kelvin → Celsius conversion...");
  const kToCRes = await unitConversionTool.execute({
    value: 273.15,
    fromUnit: "kelvin",
    toUnit: "celsius",
  });
  assert.equal(kToCRes.isError, false);
  assert.equal(kToCRes.output.result, 0);
  console.log("✓ Kelvin → Celsius conversion accurate (273.15 K = 0 C)");

  // -------------------------------------------------------------
  // Test 10: Temperature: Fahrenheit <-> Kelvin
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing Fahrenheit <-> Kelvin conversion...");
  const fToKRes = await unitConversionTool.execute({
    value: 32,
    fromUnit: "fahrenheit",
    toUnit: "kelvin",
  });
  assert.equal(fToKRes.isError, false);
  assert.equal(fToKRes.output.result, 273.15);

  const kToFRes = await unitConversionTool.execute({
    value: 273.15,
    fromUnit: "kelvin",
    toUnit: "fahrenheit",
  });
  assert.equal(kToFRes.isError, false);
  assert.equal(kToFRes.output.result, 32);
  console.log("✓ Fahrenheit <-> Kelvin conversions accurate");

  // -------------------------------------------------------------
  // Test 11: Unit Aliases and Abbreviations
  // -------------------------------------------------------------
  console.log("\n[Test 11] Testing unit aliases and abbreviations...");
  const aliasRes = await unitConversionTool.execute({
    value: 10,
    fromUnit: "km",
    toUnit: "mi",
  });
  assert.equal(aliasRes.isError, false);
  assert.equal(aliasRes.output.fromUnit, "kilometer");
  assert.equal(aliasRes.output.toUnit, "mile");

  const aliasTemp = await unitConversionTool.execute({
    value: 100,
    fromUnit: "°f",
    toUnit: "°c",
  });
  assert.equal(aliasTemp.isError, false);
  assert.equal(aliasTemp.output.fromUnit, "fahrenheit");
  assert.equal(aliasTemp.output.toUnit, "celsius");
  console.log("✓ Aliases (km, mi, lbs, °f, °c) properly normalized");

  // -------------------------------------------------------------
  // Test 12: Invalid Unit Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 12] Testing invalid unit rejection...");
  const invalidRes = await unitConversionTool.execute({
    value: 10,
    fromUnit: "lightyear",
    toUnit: "mile",
  });
  assert.equal(invalidRes.isError, true);
  assert.equal(invalidRes.output, null);
  assert.ok(invalidRes.error?.includes("Unsupported or unknown unit"));

  const invalidTarget = await unitConversionTool.execute({
    value: 10,
    fromUnit: "kilometer",
    toUnit: "parsec",
  });
  assert.equal(invalidTarget.isError, true);
  assert.equal(invalidTarget.output, null);
  console.log("✓ Unknown and unsupported units safely rejected with controlled error");

  // -------------------------------------------------------------
  // Test 13: Cross-Category Conversion Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 13] Testing cross-category conversion rejection...");
  const crossRes1 = await unitConversionTool.execute({
    value: 10,
    fromUnit: "kilogram",
    toUnit: "meter",
  });
  assert.equal(crossRes1.isError, true);
  assert.equal(crossRes1.output, null);
  assert.ok(crossRes1.error?.includes("Cannot convert between incompatible categories"));

  const crossRes2 = await unitConversionTool.execute({
    value: 10,
    fromUnit: "celsius",
    toUnit: "kilogram",
  });
  assert.equal(crossRes2.isError, true);
  assert.ok(crossRes2.error?.includes("Cannot convert between incompatible categories"));
  console.log("✓ Cross-category conversions rejected cleanly");

  // -------------------------------------------------------------
  // Test 14: Invalid Numeric Input Rejection
  // -------------------------------------------------------------
  console.log("\n[Test 14] Testing invalid numeric input rejection...");
  const nanRes = await unitConversionTool.execute({
    value: NaN,
    fromUnit: "meter",
    toUnit: "foot",
  });
  assert.equal(nanRes.isError, true);
  assert.ok(nanRes.error?.includes("must be a finite number"));

  const infRes = await unitConversionTool.execute({
    value: Infinity,
    fromUnit: "meter",
    toUnit: "foot",
  });
  assert.equal(infRes.isError, true);

  const missingValRes = await unitConversionTool.execute({
    fromUnit: "meter",
    toUnit: "foot",
  } as any);
  assert.equal(missingValRes.isError, true);
  console.log("✓ Invalid numeric inputs (NaN, Infinity, missing) safely rejected");

  // -------------------------------------------------------------
  // Test 15: Absolute Zero Boundary Enforcement
  // -------------------------------------------------------------
  console.log("\n[Test 15] Testing temperature absolute zero bounds...");
  const subZeroK = await unitConversionTool.execute({
    value: -1,
    fromUnit: "kelvin",
    toUnit: "celsius",
  });
  assert.equal(subZeroK.isError, true);
  assert.ok(subZeroK.error?.includes("absolute zero"));

  const subZeroC = await unitConversionTool.execute({
    value: -300,
    fromUnit: "celsius",
    toUnit: "fahrenheit",
  });
  assert.equal(subZeroC.isError, true);
  assert.ok(subZeroC.error?.includes("absolute zero"));
  console.log("✓ Absolute zero boundary enforced safely");

  // -------------------------------------------------------------
  // Test 16: Query Intent Matching (matchesQuery)
  // -------------------------------------------------------------
  console.log("\n[Test 16] Testing matchesQuery detection...");
  const positiveQueries = [
    "Convert 10 kilometers to miles",
    "How many pounds is 5 kilograms?",
    "Convert 100 Fahrenheit to Celsius",
    "Convert 2 meters to feet",
    "Convert 500 grams to kilograms",
    "Convert 10 km to miles",
    "How many pounds is 5 kg?",
    "How many feet are in 2 meters?",
    "10 km to miles",
    "2 meters to feet",
    "100 fahrenheit in celsius",
  ];

  for (const q of positiveQueries) {
    assert.equal(unitConversionTool.matchesQuery(q), true, `Query "${q}" should match unitConversionTool`);
  }

  const negativeQueries = [
    "What is JavaScript?",
    "Explain React hooks",
    "Tell me about MongoDB",
    "Calculate 1542 * 38",
    "What time is it?",
    "Convert this string to uppercase",
    "How many users are in the database?",
    "What is the date today?",
  ];

  for (const q of negativeQueries) {
    assert.equal(unitConversionTool.matchesQuery(q), false, `Query "${q}" should NOT match unitConversionTool`);
  }
  console.log("✓ Query intent detection accurately matches conversion requests and rejects non-conversion queries");

  // -------------------------------------------------------------
  // Test 17: ToolExecutor Execution
  // -------------------------------------------------------------
  console.log("\n[Test 17] Testing execution through ToolExecutor...");
  const callConversion: ToolCall = {
    id: "call_conv_e2e_1",
    name: "unit_conversion",
    arguments: {
      value: 10,
      fromUnit: "kilometer",
      toUnit: "mile",
    },
  };

  const execRes = await toolExecutor.execute(callConversion);
  assert.equal(execRes.toolCallId, "call_conv_e2e_1");
  assert.equal(execRes.toolName, "unit_conversion");
  assert.equal(execRes.isError, false);
  assert.equal((execRes.output as any)?.result, 6.213712);
  assert.ok(typeof execRes.durationMs === "number" && execRes.durationMs >= 0);
  console.log("✓ Execution through ToolExecutor produced normalized ToolCallResult");

  console.log("\n==================================================");
  console.log(" ALL UNIT CONVERSION TOOL TESTS PASSED (17/17)   ");
  console.log("==================================================");
};

runTests().catch((err) => {
  console.error("Unit Conversion Tool Tests Failed:", err);
  process.exit(1);
});
