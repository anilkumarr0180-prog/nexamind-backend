import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInputSchema,
} from "../tool.interface.js";
import { toolRegistry, ToolRegistry } from "../tool.registry.js";

/**
 * Input arguments for the calculator tool.
 */
export interface CalculatorInput {
  expression: string;
}

/**
 * Output result produced by the calculator tool.
 */
export interface CalculatorOutput {
  result: number;
  expression: string;
}

type TokenType = "NUMBER" | "+" | "-" | "*" | "/" | "%" | "(" | ")" | "EOF";

interface Token {
  type: TokenType;
  value?: number | undefined;
}

/**
 * Tokenizes a sanitized mathematical expression.
 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const char = expr[i]!;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (
      char === "+" ||
      char === "-" ||
      char === "*" ||
      char === "/" ||
      char === "%" ||
      char === "(" ||
      char === ")"
    ) {
      tokens.push({ type: char });
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let numStr = "";
      let hasDot = false;

      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        const c = expr[i]!;
        if (c === ".") {
          if (hasDot) {
            throw new Error("Invalid number format: multiple decimal points");
          }
          hasDot = true;
        }
        numStr += c;
        i++;
      }

      if (numStr === ".") {
        throw new Error("Invalid number format: standalone decimal point");
      }

      const num = Number(numStr);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid numeric literal: "${numStr}"`);
      }

      tokens.push({ type: "NUMBER", value: num });
      continue;
    }

    throw new Error(`Unexpected character: "${char}"`);
  }

  tokens.push({ type: "EOF" });
  return tokens;
}

/**
 * Recursive descent parser and evaluator for basic arithmetic expressions.
 * Does NOT use eval(), Function(), or any dynamic code execution.
 */
class MathParser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] || { type: "EOF" };
  }

  private consume(expected?: TokenType): Token {
    const current = this.peek();
    if (expected && current.type !== expected) {
      throw new Error(`Expected "${expected}" but found "${current.type}"`);
    }
    this.pos++;
    return current;
  }

  public parse(): number {
    if (this.peek().type === "EOF") {
      throw new Error("Expression cannot be empty");
    }

    const result = this.parseExpression();

    if (this.peek().type !== "EOF") {
      throw new Error(`Unexpected token at end of expression: "${this.peek().type}"`);
    }

    if (!Number.isFinite(result)) {
      throw new Error("Result is not a finite number");
    }

    // Clean floating-point artifacts like 0.1 + 0.2 = 0.30000000000000004
    return Math.abs(result) < 1e-15 ? 0 : Math.round(result * 1e12) / 1e12;
  }

  // Expression := Term (('+' | '-') Term)*
  private parseExpression(): number {
    let left = this.parseTerm();

    while (this.peek().type === "+" || this.peek().type === "-") {
      const op = this.consume().type;
      const right = this.parseTerm();
      if (op === "+") {
        left += right;
      } else {
        left -= right;
      }
    }

    return left;
  }

  // Term := Factor (('*' | '/' | '%') Factor)*
  private parseTerm(): number {
    let left = this.parseFactor();

    while (
      this.peek().type === "*" ||
      this.peek().type === "/" ||
      this.peek().type === "%"
    ) {
      const op = this.consume().type;
      const right = this.parseFactor();

      if (op === "*") {
        left *= right;
      } else if (op === "/") {
        if (right === 0) {
          throw new Error("Division by zero is not allowed");
        }
        left /= right;
      } else if (op === "%") {
        if (right === 0) {
          throw new Error("Modulo by zero is not allowed");
        }
        left %= right;
      }
    }

    return left;
  }

  // Factor := ('+' | '-') Factor | Primary
  private parseFactor(): number {
    if (this.peek().type === "+") {
      this.consume("+");
      return this.parseFactor();
    }
    if (this.peek().type === "-") {
      this.consume("-");
      return -this.parseFactor();
    }
    return this.parsePrimary();
  }

  // Primary := NUMBER | '(' Expression ')'
  private parsePrimary(): number {
    const token = this.peek();

    if (token.type === "NUMBER") {
      this.consume("NUMBER");
      return token.value!;
    }

    if (token.type === "(") {
      this.consume("(");
      const val = this.parseExpression();
      if (this.peek().type !== ")") {
        throw new Error("Mismatched parentheses: missing closing ')'");
      }
      this.consume(")");
      return val;
    }

    if (token.type === ")") {
      throw new Error("Unexpected closing parenthesis ')'");
    }

    if (token.type === "EOF") {
      throw new Error("Unexpected end of expression");
    }

    throw new Error(`Unexpected token: "${token.type}"`);
  }
}

/**
 * Calculator tool for evaluating arithmetic expressions safely.
 */
export class CalculatorTool
  implements AgentTool<CalculatorInput, CalculatorOutput>
{
  public readonly name = "calculator";
  public readonly description =
    "Evaluates mathematical expressions supporting addition (+), subtraction (-), multiplication (*), division (/), modulo (%), and parentheses.";

  /**
   * Determines if the user query likely requires a calculation.
   */
  public matchesQuery(query: string): boolean {
    if (!query || typeof query !== "string") {
      return false;
    }
    const q = query.trim().toLowerCase();
    // Keywords indicating mathematical calculation intent
    if (/\b(calculate|calculator|compute|computations?|eval|evaluate|arithmetic)\b/i.test(q)) {
      return true;
    }
    // Natural language math phrases e.g. "what is 1542 * 38", "how much is 100 / 4"
    if (/\b(what is|what's|how much is)\s+[\d(]/i.test(q)) {
      return true;
    }
    // Arithmetic patterns e.g. "1542 * 38", "10 / 0", "25 + 75", "(10 + 5) * 2", "50 % 4"
    if (/\b\d+(?:\.\d+)?\s*[\+\-\*/\%]\s*\d+(?:\.\d+)?\b/.test(q)) {
      return true;
    }
    return false;
  }

  public readonly schema: ToolInputSchema = {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          "The mathematical expression to evaluate (e.g. '(10 + 5) * 2 / 3').",
      },
    },
    required: ["expression"],
  };

  public async execute(
    input: CalculatorInput,
    _context?: ToolExecutionContext | undefined,
  ): Promise<ToolExecutionResult<CalculatorOutput>> {
    if (!input || typeof input !== "object" || typeof input.expression !== "string") {
      return {
        output: null as any,
        isError: true,
        error: "Input must contain a string 'expression'",
      };
    }

    const trimmed = input.expression.trim();
    if (!trimmed) {
      return {
        output: null as any,
        isError: true,
        error: "Expression cannot be empty",
      };
    }

    if (trimmed.length > 500) {
      return {
        output: null as any,
        isError: true,
        error: "Expression exceeds maximum allowed length of 500 characters",
      };
    }

    // Strict character whitelist: digits, basic arithmetic operators, parentheses, and spaces
    if (!/^[0-9+\-*/%().\s]+$/.test(trimmed)) {
      return {
        output: null as any,
        isError: true,
        error:
          "Expression contains invalid or unsafe characters. Only digits, basic arithmetic operators (+, -, *, /, %), parentheses, and spaces are allowed.",
      };
    }

    try {
      const tokens = tokenize(trimmed);
      const parser = new MathParser(tokens);
      const result = parser.parse();

      return {
        output: {
          result,
          expression: trimmed,
        },
        isError: false,
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to evaluate expression";

      return {
        output: null as any,
        isError: true,
        error: errorMessage,
      };
    }
  }
}

/**
 * Singleton instance of the Calculator tool.
 */
export const calculatorTool = new CalculatorTool();

/**
 * Helper to register the calculator tool into a given registry (defaults to global toolRegistry).
 */
export const registerCalculatorTool = (
  registry: ToolRegistry = toolRegistry,
): void => {
  if (!registry.has(calculatorTool.name)) {
    registry.register(calculatorTool);
  }
};

// Register by default in global tool registry
registerCalculatorTool(toolRegistry);
