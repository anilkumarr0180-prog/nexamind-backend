import { env } from "../../../config/env.js";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInputSchema,
} from "../tool.interface.js";
import { toolRegistry, ToolRegistry } from "../tool.registry.js";

/**
 * Default fallback configuration parameters for the Web Search tool.
 */
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_WEB_SEARCH_MAX_QUERY_LENGTH = 400;

/**
 * User-neutral fallback error message for AI when web search fails or is unavailable.
 * Prevents leaking technical configuration details, environment variables, or provider internals.
 */
export const WEB_SEARCH_UNAVAILABLE_MESSAGE =
  "Web search is currently unavailable. Please continue using the available information.";

/**
 * Resolves the configured timeout in milliseconds from environment or default.
 */
export function getWebSearchTimeoutMs(): number {
  const envVal = Number(process.env.WEB_SEARCH_TIMEOUT_MS);
  return Number.isFinite(envVal) && envVal > 0
    ? envVal
    : DEFAULT_WEB_SEARCH_TIMEOUT_MS;
}

/**
 * Resolves the maximum number of results to request from environment or default.
 */
export function getWebSearchMaxResults(): number {
  const envVal = Number(process.env.WEB_SEARCH_MAX_RESULTS);
  return Number.isFinite(envVal) && envVal > 0
    ? envVal
    : DEFAULT_WEB_SEARCH_MAX_RESULTS;
}

/**
 * Resolves the maximum allowed search query length from environment or default.
 */
export function getWebSearchMaxQueryLength(): number {
  const envVal = Number(process.env.WEB_SEARCH_MAX_QUERY_LENGTH);
  return Number.isFinite(envVal) && envVal > 0
    ? envVal
    : DEFAULT_WEB_SEARCH_MAX_QUERY_LENGTH;
}

/**
 * Resolves the Tavily API key from environment variables.
 */
export function getTavilyApiKey(): string {
  return (process.env.TAVILY_API_KEY ?? env.TAVILY_API_KEY ?? "").trim();
}

/**
 * Validates that a string is a well-formed HTTP or HTTPS URL.
 */
export function isValidWebUrl(urlStr: unknown): boolean {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    return false;
  }
  try {
    const parsed = new URL(urlStr.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Input arguments for the web search tool.
 */

/**
 * Strips conversational meta-phrases and collapses redundant whitespace
 * to optimize Tavily vector and keyword search relevance while strictly
 * preserving legitimate technical queries.
 */
export function sanitizeWebSearchQuery(query: string): string {
  if (typeof query !== "string") {
    return "";
  }

  const rawTrimmed = query.trim();
  if (!rawTrimmed) {
    return "";
  }

  // 1. Collapse consecutive whitespace / newlines / tabs into one space
  let q = rawTrimmed.replace(/\s+/g, " ");

  // 2. Remove leading conversational wrappers
  const leadingWrapperRegex =
    /^(?:please\s+)?(?:search\s+(?:the\s+web|online|the\s+internet)(?:\s+(?:for|about))?|search\s+(?:for|about)|look\s+up|google)(?:\s*[:,-]\s*|\s+)/i;

  q = q.replace(leadingWrapperRegex, "");

  // 3. Remove trailing AI instructions
  const trailingDirectiveRegex =
    /(?:(?<=[?.;])\s*|\s*,\s*)(?:please\s+)?(?:(?:search\s+(?:the\s+web|online|the\s+internet)|cite\s+(?:your\s+)?sources?|provide\s+(?:your\s+)?(?:sources?|links?)|include\s+(?:your\s+)?sources?|give\s+(?:your\s+)?sources?)(?:\s+(?:and|with)\s+(?:search\s+(?:the\s+web|online|the\s+internet)|cite\s+(?:your\s+)?sources?|provide\s+(?:your\s+)?(?:sources?|links?)|include\s+(?:your\s+)?sources?|give\s+(?:your\s+)?sources?|sources?))?)\s*[.?!]*$/i;

  q = q.replace(trailingDirectiveRegex, "").trim();

  // 4. Fallback if empty
  return q || rawTrimmed;
}

export interface WebSearchInput {
  query: string;
}

/**
 * Normalized item representing a single web search result.
 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  content: string;
}

/**
 * Structured output produced by the web search tool.
 */
export interface WebSearchOutput {
  query: string;
  results: WebSearchResultItem[];
  totalResults: number;
  message?: string | undefined;
}

/**
 * Optional configuration overrides for WebSearchTool (e.g. for testing and isolation).
 */
export interface WebSearchToolOptions {
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  maxResults?: number | undefined;
  maxQueryLength?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  disableCache?: boolean | undefined;
}

/**
 * Web Search tool for querying current live web results via Tavily Search API.
 */
export class WebSearchTool
  implements AgentTool<WebSearchInput, WebSearchOutput>
{
  public readonly name = "web_search";
  public readonly description =
    "Performs a live web search using Tavily Search API to retrieve up-to-date information, news, facts, and web content.";

  private readonly executionCache = new Map<string, WebSearchResultItem[]>();

  constructor(private readonly options?: WebSearchToolOptions) {}

  public clearCache(): void {
    this.executionCache.clear();
  }

  /**
   * Determines if the user query likely requires a live web search.
   */
  public matchesQuery(query: string): boolean {
    if (!query || typeof query !== "string") {
      return false;
    }
    const q = query.trim().toLowerCase();

    // Exclude pure math expressions or calculations unless explicit search/lookup action is present
    const hasSearchAction = /\b(search|look up|lookup|google)\b/i.test(q);
    if (!hasSearchAction) {
      if (/\b(calculate|calculator|compute|eval|arithmetic)\b/i.test(q)) {
        return false;
      }
      if (/^\s*\d+(?:\.\d+)?\s*[\+\-\*\/%]\s*\d+/.test(q)) {
        return false;
      }
    }

    // Exclude pure datetime queries
    if (
      /\b(what time is it|what's the time|current time|what is today'?s date|what day is today|day of the week)\b/i.test(
        q,
      )
    ) {
      return false;
    }

    // Exclude pure unit conversions
    if (/\b(convert|conversion)\b/i.test(q) && /\b(to|into)\b/i.test(q)) {
      return false;
    }

    // 1. Direct explicit search intent actions
    if (
      /\b(search for|search the web|search online|web search|internet search|browse the web|search (?:the )?(?:latest|current|recent))\b/i.test(
        q,
      ) ||
      /\b(look up|google)\b/i.test(q) ||
      /\bfind (?:recent|latest|current|online) (?:info|information|news|updates?|data)\b/i.test(
        q,
      ) ||
      /\bfind out (?:the )?(?:latest|current|recent)\b/i.test(q)
    ) {
      return true;
    }

    // 2. Inquiries asking for "latest" version, release, update, news
    if (
      /\b(?:what is|what's|tell me|check)\s+(?:the\s+)?latest\b/i.test(q) ||
      /\blatest\s+[a-z0-9._-]+\s*(?:version|release|update|news|status|price|model|event|scores?)\b/i.test(
        q,
      ) ||
      /\blatest\s+(?:news|version|release|updates?|developments?|headlines?)\b/i.test(
        q,
      )
    ) {
      return true;
    }

    // 3. Inquiries asking for "current" real-time status/version/price/weather/forecast
    if (
      /\b(?:what is|what's|how is|how's|tell me)\s+(?:the\s+)?(?:current\s+)?(?:price|version|weather|forecast|status|leader|president|prime minister)\b/i.test(
        q,
      ) ||
      /\b(?:weather|forecast|rain|raining|snow|snowing)\b.*\b(?:in|for|at|today|tomorrow|this week|look like)\b/i.test(
        q,
      ) ||
      /\bcurrent\s+(?:price|version|weather|stock price|exchange rate|interest rate|status)\s+of\b/i.test(
        q,
      ) ||
      /\bcurrent\s+[a-z0-9._-]+\s*(?:version|release)\b/i.test(q) ||
      /\b(?:weather in|stock price of|current price of)\b/i.test(q)
    ) {
      return true;
    }

    // 4. Live events / recent news inquiries
    if (
      /\bwhat happened\b.*\b(today|yesterday|this week|recently)\b/i.test(q) ||
      /\b(?:news|headlines|breaking news)\b.*\b(today|this week|right now)\b/i.test(
        q,
      ) ||
      /\brecent\s+(?:information|info|news|updates?|developments?)\s+(?:about|on|regarding|for)\b/i.test(
        q,
      )
    ) {
      return true;
    }

    return false;
  }

  public readonly schema: ToolInputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to look up on the web.",
      },
    },
    required: ["query"],
  };

  public async execute(
    input: WebSearchInput,
    context?: ToolExecutionContext | undefined,
  ): Promise<ToolExecutionResult<WebSearchOutput>> {
    // 1. Validate input structure
    if (!input || typeof input !== "object" || typeof input.query !== "string") {
      return {
        output: null as any,
        isError: true,
        error: "Input must contain a string 'query'",
      };
    }

    const trimmedQuery = input.query.trim();

    // 2. Validate query is non-empty
    if (!trimmedQuery) {
      return {
        output: null as any,
        isError: true,
        error: "Query cannot be empty",
      };
    }

    // 3. Validate query length
    const maxQueryLength =
      this.options?.maxQueryLength ?? getWebSearchMaxQueryLength();
    if (trimmedQuery.length > maxQueryLength) {
      return {
        output: null as any,
        isError: true,
        error: `Query exceeds maximum allowed length of ${maxQueryLength} characters`,
      };
    }

    // Sanitize query for Tavily search and duplicate prevention
    const sanitizedQuery = sanitizeWebSearchQuery(trimmedQuery);
    const cacheKey = sanitizedQuery.toLowerCase();

    // Deduplication check: reuse results if identical sanitized query was already executed
    if (!this.options?.disableCache && this.executionCache.has(cacheKey)) {
      const cachedResults = this.executionCache.get(cacheKey)!;
      return {
        output: {
          query: trimmedQuery,
          results: cachedResults,
          totalResults: cachedResults.length,
          ...(cachedResults.length === 0
            ? { message: `No search results found for "${trimmedQuery}"` }
            : {}),
        },
        isError: false,
      };
    }

    // 4. Validate API key presence
    const apiKey = (this.options?.apiKey ?? getTavilyApiKey()).trim();
    if (!apiKey) {
      console.warn("[WebSearchTool] Tavily API key is not configured");
      return {
        output: null as any,
        isError: true,
        error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
      };
    }

    // 5. Configure execution parameters
    const timeoutMs = this.options?.timeoutMs ?? getWebSearchTimeoutMs();
    const maxResults = this.options?.maxResults ?? getWebSearchMaxResults();
    const fetchImpl = this.options?.fetchFn ?? globalThis.fetch;

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let signalListener: (() => void) | undefined;
    if (context?.signal) {
      if (context.signal.aborted) {
        clearTimeout(timeoutId);
        return {
          output: null as any,
          isError: true,
          error: "Tool execution cancelled",
        };
      }
      signalListener = () => {
        controller.abort();
      };
      context.signal.addEventListener("abort", signalListener, { once: true });
    }

    try {
      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: sanitizedQuery,
          max_results: maxResults,
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        console.warn("[WebSearchTool] Tavily API error:", {
          status: response.status,
        });
        return {
          output: null as any,
          isError: true,
          error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        };
      }

      if (response.status === 429) {
        console.warn("[WebSearchTool] Tavily API error:", {
          status: response.status,
        });
        return {
          output: null as any,
          isError: true,
          error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        };
      }

      if (!response.ok) {
        console.warn("[WebSearchTool] Tavily API error:", {
          status: response.status,
        });
        return {
          output: null as any,
          isError: true,
          error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        };
      }

      let data: any;
      try {
        data = (await response.json()) as any;
      } catch {
        console.warn("[WebSearchTool] Tavily API error: Received invalid JSON response");
        return {
          output: null as any,
          isError: true,
          error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        };
      }

      const rawResults = Array.isArray(data?.results) ? data.results : [];
      const normalizedResults: WebSearchResultItem[] = rawResults
        .filter((item: any) => item && typeof item === "object")
        .filter((item: any) => isValidWebUrl(item.url))
        .slice(0, maxResults)
        .map((item: any) => ({
          title: typeof item?.title === "string" ? item.title.trim() : "",
          url: item.url.trim(),
          content: typeof item?.content === "string" ? item.content.trim() : "",
        }));

      // Cache successful normalized results by sanitized query
      if (!this.options?.disableCache) {
        if (this.executionCache.size >= 100) {
          const oldestKey = this.executionCache.keys().next().value;
          if (oldestKey) this.executionCache.delete(oldestKey);
        }
        this.executionCache.set(cacheKey, normalizedResults);
      }

      if (normalizedResults.length === 0) {
        return {
          output: {
            query: trimmedQuery,
            results: [],
            totalResults: 0,
            message: `No search results found for "${trimmedQuery}"`,
          },
          isError: false,
        };
      }

      return {
        output: {
          query: trimmedQuery,
          results: normalizedResults,
          totalResults: normalizedResults.length,
        },
        isError: false,
      };
    } catch (err: unknown) {
      if (timedOut) {
        console.warn("[WebSearchTool] Tavily request failed:", {
          reason: "timeout",
        });
        return {
          output: null as any,
          isError: true,
          error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        };
      }

      if (context?.signal?.aborted) {
        return {
          output: null as any,
          isError: true,
          error: "Tool execution cancelled",
        };
      }

      const rawMessage =
        err instanceof Error ? err.message : "Network error occurred";
      const safeErrorReason = apiKey
        ? rawMessage.replaceAll(apiKey, "[REDACTED]")
        : rawMessage;

      console.warn("[WebSearchTool] Tavily request failed:", {
        reason: safeErrorReason,
      });

      return {
        output: null as any,
        isError: true,
        error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
      };
    } finally {
      clearTimeout(timeoutId);
      if (context?.signal && signalListener) {
        context.signal.removeEventListener("abort", signalListener);
      }
    }
  }
}

/**
 * Singleton instance of the WebSearch tool.
 */
export const webSearchTool = new WebSearchTool();

/**
 * Helper to register the web search tool into a given registry (defaults to global toolRegistry).
 */
export const registerWebSearchTool = (
  registry: ToolRegistry = toolRegistry,
): void => {
  if (!registry.has(webSearchTool.name)) {
    registry.register(webSearchTool);
  }
};

// Register by default in global tool registry
registerWebSearchTool(toolRegistry);
