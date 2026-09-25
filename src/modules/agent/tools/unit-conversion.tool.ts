import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInputSchema,
} from "../tool.interface.js";
import { toolRegistry, ToolRegistry } from "../tool.registry.js";

/**
 * Supported categories for unit conversion.
 */
export type UnitCategory = "length" | "mass" | "temperature";

/**
 * Supported canonical length units.
 */
export type LengthUnit =
  | "millimeter"
  | "centimeter"
  | "meter"
  | "kilometer"
  | "inch"
  | "foot"
  | "yard"
  | "mile";

/**
 * Supported canonical mass/weight units.
 */
export type MassUnit =
  | "milligram"
  | "gram"
  | "kilogram"
  | "ounce"
  | "pound";

/**
 * Supported canonical temperature units.
 */
export type TemperatureUnit =
  | "celsius"
  | "fahrenheit"
  | "kelvin";

/**
 * Union of all supported canonical units.
 */
export type SupportedUnit = LengthUnit | MassUnit | TemperatureUnit;

/**
 * Input arguments for the unit conversion tool.
 */
export interface UnitConversionInput {
  value: number;
  fromUnit: string;
  toUnit: string;
}

/**
 * Structured output result produced by the unit conversion tool.
 */
export interface UnitConversionOutput {
  value: number;
  fromUnit: string;
  toUnit: string;
  category: UnitCategory;
  result: number;
  formatted: string;
}

/**
 * Multiplicative factors to normalize length units to base unit (meter).
 */
const LENGTH_FACTORS_TO_METER: Record<LengthUnit, number> = {
  millimeter: 0.001,
  centimeter: 0.01,
  meter: 1,
  kilometer: 1000,
  inch: 0.0254,
  foot: 0.3048,
  yard: 0.9144,
  mile: 1609.344,
};

/**
 * Multiplicative factors to normalize mass units to base unit (gram).
 */
const MASS_FACTORS_TO_GRAM: Record<MassUnit, number> = {
  milligram: 0.001,
  gram: 1,
  kilogram: 1000,
  ounce: 28.349523125,
  pound: 453.59237,
};

/**
 * Comprehensive dictionary of aliases mapping colloquial or abbreviation strings to canonical units.
 */
const UNIT_ALIASES: Record<string, { unit: SupportedUnit; category: UnitCategory }> = {
  // Length
  millimeter: { unit: "millimeter", category: "length" },
  millimeters: { unit: "millimeter", category: "length" },
  millimetre: { unit: "millimeter", category: "length" },
  millimetres: { unit: "millimeter", category: "length" },
  mm: { unit: "millimeter", category: "length" },

  centimeter: { unit: "centimeter", category: "length" },
  centimeters: { unit: "centimeter", category: "length" },
  centimetre: { unit: "centimeter", category: "length" },
  centimetres: { unit: "centimeter", category: "length" },
  cm: { unit: "centimeter", category: "length" },

  meter: { unit: "meter", category: "length" },
  meters: { unit: "meter", category: "length" },
  metre: { unit: "meter", category: "length" },
  metres: { unit: "meter", category: "length" },
  m: { unit: "meter", category: "length" },

  kilometer: { unit: "kilometer", category: "length" },
  kilometers: { unit: "kilometer", category: "length" },
  kilometre: { unit: "kilometer", category: "length" },
  kilometres: { unit: "kilometer", category: "length" },
  km: { unit: "kilometer", category: "length" },
  kms: { unit: "kilometer", category: "length" },

  inch: { unit: "inch", category: "length" },
  inches: { unit: "inch", category: "length" },
  in: { unit: "inch", category: "length" },
  '"': { unit: "inch", category: "length" },

  foot: { unit: "foot", category: "length" },
  feet: { unit: "foot", category: "length" },
  ft: { unit: "foot", category: "length" },
  "'": { unit: "foot", category: "length" },

  yard: { unit: "yard", category: "length" },
  yards: { unit: "yard", category: "length" },
  yd: { unit: "yard", category: "length" },
  yds: { unit: "yard", category: "length" },

  mile: { unit: "mile", category: "length" },
  miles: { unit: "mile", category: "length" },
  mi: { unit: "mile", category: "length" },

  // Mass / Weight
  milligram: { unit: "milligram", category: "mass" },
  milligrams: { unit: "milligram", category: "mass" },
  mg: { unit: "milligram", category: "mass" },

  gram: { unit: "gram", category: "mass" },
  grams: { unit: "gram", category: "mass" },
  g: { unit: "gram", category: "mass" },
  gm: { unit: "gram", category: "mass" },
  gms: { unit: "gram", category: "mass" },

  kilogram: { unit: "kilogram", category: "mass" },
  kilograms: { unit: "kilogram", category: "mass" },
  kilo: { unit: "kilogram", category: "mass" },
  kilos: { unit: "kilogram", category: "mass" },
  kg: { unit: "kilogram", category: "mass" },
  kgs: { unit: "kilogram", category: "mass" },

  ounce: { unit: "ounce", category: "mass" },
  ounces: { unit: "ounce", category: "mass" },
  oz: { unit: "ounce", category: "mass" },

  pound: { unit: "pound", category: "mass" },
  pounds: { unit: "pound", category: "mass" },
  lb: { unit: "pound", category: "mass" },
  lbs: { unit: "pound", category: "mass" },

  // Temperature
  celsius: { unit: "celsius", category: "temperature" },
  centigrade: { unit: "celsius", category: "temperature" },
  c: { unit: "celsius", category: "temperature" },
  "°c": { unit: "celsius", category: "temperature" },
  "degree celsius": { unit: "celsius", category: "temperature" },
  "degrees celsius": { unit: "celsius", category: "temperature" },

  fahrenheit: { unit: "fahrenheit", category: "temperature" },
  f: { unit: "fahrenheit", category: "temperature" },
  "°f": { unit: "fahrenheit", category: "temperature" },
  "degree fahrenheit": { unit: "fahrenheit", category: "temperature" },
  "degrees fahrenheit": { unit: "fahrenheit", category: "temperature" },

  kelvin: { unit: "kelvin", category: "temperature" },
  k: { unit: "kelvin", category: "temperature" },
  "°k": { unit: "kelvin", category: "temperature" },
  "degree kelvin": { unit: "kelvin", category: "temperature" },
  "degrees kelvin": { unit: "kelvin", category: "temperature" },
};

/**
 * Resolves a raw unit string to its canonical SupportedUnit and UnitCategory.
 */
function resolveUnit(raw: unknown): { unit: SupportedUnit; category: UnitCategory } | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^degrees?\s+/i, "degree ")
    .replace(/[\s_-]+/g, " ");

  return UNIT_ALIASES[normalized] || UNIT_ALIASES[raw.trim().toLowerCase()];
}

/**
 * Converts temperature between Celsius, Fahrenheit, and Kelvin using explicit non-linear formulas.
 */
function convertTemperature(
  value: number,
  from: TemperatureUnit,
  to: TemperatureUnit,
): number {
  if (from === to) {
    return value;
  }

  // Validate absolute zero bounds
  if (from === "kelvin" && value < 0) {
    throw new Error("Temperature in Kelvin cannot be below absolute zero (0 K)");
  }
  if (from === "celsius" && value < -273.15) {
    throw new Error("Temperature in Celsius cannot be below absolute zero (-273.15 °C)");
  }
  if (from === "fahrenheit" && value < -459.67) {
    throw new Error("Temperature in Fahrenheit cannot be below absolute zero (-459.67 °F)");
  }

  // Convert source unit to Celsius
  let celsius: number;
  switch (from) {
    case "celsius":
      celsius = value;
      break;
    case "fahrenheit":
      celsius = (value - 32) * (5 / 9);
      break;
    case "kelvin":
      celsius = value - 273.15;
      break;
  }

  // Convert Celsius to target unit
  switch (to) {
    case "celsius":
      return celsius;
    case "fahrenheit":
      return celsius * (9 / 5) + 32;
    case "kelvin":
      return celsius + 273.15;
  }
}

/**
 * Cleans floating-point representation artifacts to a sensible precision level (defaults to 6 decimal places).
 */
function cleanPrecision(num: number, maxDecimals = 6): number {
  if (!Number.isFinite(num)) {
    return num;
  }
  if (Number.isInteger(num)) {
    return num;
  }
  const factor = Math.pow(10, maxDecimals);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

/**
 * Deterministic Unit Conversion Tool.
 *
 * Supports length, weight/mass, and temperature conversions through normalized
 * base units and explicit thermal formulas.
 */
export class UnitConversionTool
  implements AgentTool<UnitConversionInput, UnitConversionOutput>
{
  public readonly name = "unit_conversion";
  public readonly description =
    "Converts numeric measurements between units of length (millimeter, centimeter, meter, kilometer, inch, foot, yard, mile), mass/weight (milligram, gram, kilogram, ounce, pound), and temperature (celsius, fahrenheit, kelvin).";

  /**
   * Determines if the user query requires a unit conversion.
   */
  public matchesQuery(query: string): boolean {
    if (!query || typeof query !== "string") {
      return false;
    }
    const q = query.trim().toLowerCase();

    // Prevent collision with arithmetic evaluations and time queries
    if (/\b(calculate|calculator|compute|eval|arithmetic)\b/i.test(q)) {
      return false;
    }
    if (/\b(what time|current time|today's date|day of the week)\b/i.test(q)) {
      return false;
    }

    const unitPattern =
      "millimeter|millimeter|centimeter|centimeters|meter|meters|metre|metres|kilometer|kilometers|inch|inches|foot|feet|yard|yards|mile|miles|milligram|milligrams|gram|grams|kilogram|kilograms|kilo|kilos|ounce|ounces|pound|pounds|celsius|centigrade|fahrenheit|kelvin|mm|cm|km|ft|yd|mi|mg|oz|lb|lbs|°c|°f|°k";

    // 1. Explicit convert / conversion patterns with supported unit mentions:
    // e.g. "convert 10 km to miles", "convert 100 fahrenheit to celsius", "convert 2 meters to feet"
    if (
      /\b(convert|conversion|convertor|converting)\b/i.test(q) &&
      new RegExp(`\\b(${unitPattern}|m|g|c|f|k)\\b`, "i").test(q)
    ) {
      return true;
    }

    // 2. Natural query patterns:
    // e.g. "how many pounds is 5 kilograms?", "how many feet are in 2 meters?"
    if (
      new RegExp(`\\bhow\\s+many\\s+(${unitPattern})\\s+(?:are\\s+in|is|in)\\s+[\\d.]+`, "i").test(q) ||
      new RegExp(`\\bhow\\s+many\\s+[a-z°]+\\s+(?:are\\s+in|is|in)\\s+[\\d.]+\\s*(${unitPattern})\\b`, "i").test(q) ||
      new RegExp(`\\bhow\\s+much\\s+is\\s+[\\d.]+\\s*(${unitPattern})\\s+in\\s+(${unitPattern})\\b`, "i").test(q)
    ) {
      return true;
    }

    // 3. Direct conversion shorthand:
    // e.g. "10 km to miles", "5 kg to lbs", "100 fahrenheit in celsius", "2 meters to feet"
    if (
      new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(${unitPattern})\\s+(?:to|into|in)\\s+(${unitPattern}|m|g|c|f|k)\\b`, "i").test(q)
    ) {
      return true;
    }

    return false;
  }

  public readonly schema: ToolInputSchema = {
    type: "object",
    properties: {
      value: {
        type: "number",
        description: "The numeric measurement value to convert (e.g. 10, 5.5, -40).",
      },
      fromUnit: {
        type: "string",
        description:
          "The source unit to convert from (e.g. 'kilometer', 'meter', 'celsius', 'fahrenheit', 'kilogram', 'pound').",
      },
      toUnit: {
        type: "string",
        description:
          "The target unit to convert to (e.g. 'mile', 'foot', 'fahrenheit', 'celsius', 'pound', 'gram').",
      },
    },
    required: ["value", "fromUnit", "toUnit"],
  };

  public async execute(
    input: UnitConversionInput,
    _context?: ToolExecutionContext | undefined,
  ): Promise<ToolExecutionResult<UnitConversionOutput>> {
    if (!input || typeof input !== "object") {
      return {
        output: null as any,
        isError: true,
        error: "Input must be an object with 'value', 'fromUnit', and 'toUnit'",
      };
    }

    // Flexible extraction to accommodate varied LLM caller parameter conventions
    const rawVal =
      (input as any).value ?? (input as any).amount ?? (input as any).val;
    const rawFrom =
      (input as any).fromUnit ?? (input as any).from_unit ?? (input as any).from;
    const rawTo =
      (input as any).toUnit ?? (input as any).to_unit ?? (input as any).to;

    if (rawVal === undefined || rawVal === null) {
      return {
        output: null as any,
        isError: true,
        error: "Missing required argument 'value'",
      };
    }

    const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(numVal)) {
      return {
        output: null as any,
        isError: true,
        error: `Input 'value' must be a finite number, received: ${String(rawVal)}`,
      };
    }

    if (typeof rawFrom !== "string" || !rawFrom.trim()) {
      return {
        output: null as any,
        isError: true,
        error: "Missing or invalid required argument 'fromUnit'",
      };
    }

    if (typeof rawTo !== "string" || !rawTo.trim()) {
      return {
        output: null as any,
        isError: true,
        error: "Missing or invalid required argument 'toUnit'",
      };
    }

    const fromNorm = resolveUnit(rawFrom);
    if (!fromNorm) {
      return {
        output: null as any,
        isError: true,
        error: `Unsupported or unknown unit: "${rawFrom.trim()}". Supported units are: millimeter, centimeter, meter, kilometer, inch, foot, yard, mile, milligram, gram, kilogram, ounce, pound, celsius, fahrenheit, kelvin.`,
      };
    }

    const toNorm = resolveUnit(rawTo);
    if (!toNorm) {
      return {
        output: null as any,
        isError: true,
        error: `Unsupported or unknown unit: "${rawTo.trim()}". Supported units are: millimeter, centimeter, meter, kilometer, inch, foot, yard, mile, milligram, gram, kilogram, ounce, pound, celsius, fahrenheit, kelvin.`,
      };
    }

    if (fromNorm.category !== toNorm.category) {
      return {
        output: null as any,
        isError: true,
        error: `Cannot convert between incompatible categories: "${fromNorm.category}" ("${fromNorm.unit}") and "${toNorm.category}" ("${toNorm.unit}")`,
      };
    }

    let rawResult: number;

    try {
      if (fromNorm.category === "length") {
        const fromFactor = LENGTH_FACTORS_TO_METER[fromNorm.unit as LengthUnit];
        const toFactor = LENGTH_FACTORS_TO_METER[toNorm.unit as LengthUnit];
        const meters = numVal * fromFactor;
        rawResult = meters / toFactor;
      } else if (fromNorm.category === "mass") {
        const fromFactor = MASS_FACTORS_TO_GRAM[fromNorm.unit as MassUnit];
        const toFactor = MASS_FACTORS_TO_GRAM[toNorm.unit as MassUnit];
        const grams = numVal * fromFactor;
        rawResult = grams / toFactor;
      } else {
        rawResult = convertTemperature(
          numVal,
          fromNorm.unit as TemperatureUnit,
          toNorm.unit as TemperatureUnit,
        );
      }
    } catch (err: unknown) {
      return {
        output: null as any,
        isError: true,
        error: err instanceof Error ? err.message : "Unit conversion failed",
      };
    }

    const result = cleanPrecision(rawResult, 6);
    const formatted = `${numVal} ${fromNorm.unit} = ${result} ${toNorm.unit}`;

    return {
      output: {
        value: numVal,
        fromUnit: fromNorm.unit,
        toUnit: toNorm.unit,
        category: fromNorm.category,
        result,
        formatted,
      },
      isError: false,
    };
  }
}

/**
 * Singleton instance of the UnitConversionTool.
 */
export const unitConversionTool = new UnitConversionTool();

/**
 * Helper to register the unit conversion tool into a given registry (defaults to global toolRegistry).
 */
export const registerUnitConversionTool = (
  registry: ToolRegistry = toolRegistry,
): void => {
  if (!registry.has(unitConversionTool.name)) {
    registry.register(unitConversionTool);
  }
};

// Register by default in global tool registry
registerUnitConversionTool(toolRegistry);
