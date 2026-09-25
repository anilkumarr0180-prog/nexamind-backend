import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInputSchema,
} from "../tool.interface.js";
import { toolRegistry, ToolRegistry } from "../tool.registry.js";

/**
 * Input arguments for the date/time tool.
 */
export interface DateTimeInput {
  timezone?: string | undefined;
}

/**
 * Structured output result produced by the date/time tool.
 */
export interface DateTimeOutput {
  timezone: string;
  iso: string;
  date: string;
  time: string;
  dayOfWeek: string;
  formatted: string;
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  timestamp: number;
}

/**
 * Common timezone aliases mapping informal names to canonical IANA timezone identifiers.
 */
const TIMEZONE_ALIASES: Record<string, string> = {
  india: "Asia/Kolkata",
  ist: "Asia/Kolkata",
  london: "Europe/London",
  uk: "Europe/London",
  gmt: "UTC",
  utc: "UTC",
  new_york: "America/New_York",
  ny: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  tokyo: "Asia/Tokyo",
  japan: "Asia/Tokyo",
  jst: "Asia/Tokyo",
  paris: "Europe/Paris",
  france: "Europe/Paris",
  berlin: "Europe/Berlin",
  germany: "Europe/Berlin",
  sydney: "Australia/Sydney",
  australia: "Australia/Sydney",
  dubai: "Asia/Dubai",
  uae: "Asia/Dubai",
  singapore: "Asia/Singapore",
  toronto: "America/Toronto",
  canada: "America/Toronto",
};

/**
 * Resolves and validates a timezone string using the platform's Intl implementation.
 */
function resolveAndValidateTimezone(rawTz?: string): { timezone: string; error?: string } {
  if (!rawTz || !rawTz.trim()) {
    return { timezone: "UTC" };
  }

  const trimmed = rawTz.trim();
  const normalizedKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const resolved = TIMEZONE_ALIASES[normalizedKey] || trimmed;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: resolved });
    return { timezone: resolved };
  } catch {
    return {
      timezone: trimmed,
      error: `Invalid or unsupported timezone: "${trimmed}"`,
    };
  }
}

/**
 * Date/Time tool for retrieving current date, time, weekday, and timezone data.
 */
export class DateTimeTool
  implements AgentTool<DateTimeInput, DateTimeOutput>
{
  public readonly name = "datetime";
  public readonly description =
    "Gets the current date, time, day of the week, and timezone information. Supports optional timezone specification (e.g. 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'UTC'). Defaults to UTC.";

  /**
   * Determines if the user query requires current date or time information.
   */
  public matchesQuery(query: string): boolean {
    if (!query || typeof query !== "string") {
      return false;
    }
    const q = query.trim().toLowerCase();

    // Direct temporal keyword phrases
    if (
      /\b(what time is it|what's the time|current time|time now|what is the time)\b/i.test(q) ||
      /\b(what is today'?s date|what'?s today'?s date|today'?s date|current date|date today)\b/i.test(q) ||
      /\b(what day is today|what day is it|current day|day of the week)\b/i.test(q) ||
      /\b(current date and time|current datetime|date and time right now)\b/i.test(q)
    ) {
      return true;
    }

    // Patterns asking for time/date in a specific location/timezone
    // e.g. "what time is it in London", "time in India", "current time in Tokyo"
    if (
      /\b(?:time|date|day)\b.*\bin\s+[a-z_\/]+/i.test(q) &&
      /\b(what|current|tell|give|check|now)\b/i.test(q)
    ) {
      return true;
    }

    // General time/date queries e.g. "what is the date today", "tell me the time now"
    if (
      /\b(what|tell me|give me|check)\b.*\b(time|date|day of week|datetime)\b.*\b(now|today|currently|right now)\b/i.test(q)
    ) {
      return true;
    }

    return false;
  }

  public readonly schema: ToolInputSchema = {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "Optional IANA timezone name (e.g. 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'UTC'). If omitted, defaults to UTC.",
      },
    },
  };

  public async execute(
    input?: DateTimeInput,
    _context?: ToolExecutionContext | undefined,
  ): Promise<ToolExecutionResult<DateTimeOutput>> {
    const rawTz =
      typeof input === "object" && input !== null && typeof input.timezone === "string"
        ? input.timezone
        : undefined;

    const { timezone, error } = resolveAndValidateTimezone(rawTz);
    if (error) {
      return {
        output: null as any,
        isError: true,
        error,
      };
    }

    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        weekday: "long",
      });

      const parts = Object.fromEntries(
        formatter.formatToParts(now).map((p) => [p.type, p.value]),
      );

      const humanFormatted = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);

      const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
      const timeStr = `${parts.hour}:${parts.minute}:${parts.second}`;

      const output: DateTimeOutput = {
        timezone,
        iso: now.toISOString(),
        date: dateStr,
        time: timeStr,
        dayOfWeek: parts.weekday || "Unknown",
        formatted: humanFormatted,
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hours: Number(parts.hour),
        minutes: Number(parts.minute),
        seconds: Number(parts.second),
        timestamp: now.getTime(),
      };

      return {
        output,
        isError: false,
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to retrieve date and time";

      return {
        output: null as any,
        isError: true,
        error: errorMessage,
      };
    }
  }
}

/**
 * Singleton instance of the DateTime tool.
 */
export const dateTimeTool = new DateTimeTool();

/**
 * Helper to register the datetime tool into a given registry (defaults to global toolRegistry).
 */
export const registerDateTimeTool = (
  registry: ToolRegistry = toolRegistry,
): void => {
  if (!registry.has(dateTimeTool.name)) {
    registry.register(dateTimeTool);
  }
};

// Register by default in global tool registry
registerDateTimeTool(toolRegistry);
