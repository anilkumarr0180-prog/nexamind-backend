import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const backendRoot = path.resolve(__dirname, "..");

export interface LoadTestConfig {
  scenario: "all" | "chat" | "agent" | "voice" | "credit";
  chatConcurrencyTiers: number[];
  agentConcurrencyTiers: number[];
  voiceConcurrencyTiers: number[];
  creditConcurrencyCount: number;
  voiceAudioSizeMB: number;
  baseline: boolean;
  realProviders: boolean;
  targetUrl?: string;
  chunkDelayMs: number;
  toolDelayMs: number;
  testDbUri: string;
}

export function maskMongoUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
  }
}

export function validateEnvironmentSafeguards(targetUrl?: string): void {
  // 1. Strict NODE_ENV check
  const nodeEnv = process.env.NODE_ENV?.toLowerCase() || "development";
  if (nodeEnv === "production") {
    throw new Error(
      "[SAFEGUARD ABORT] Refusing to run load tests with NODE_ENV=production. Load tests must only run in development, test, or isolated staging environments."
    );
  }

  // 2. Target URL safeguard
  if (targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      const host = parsedUrl.hostname.toLowerCase();
      const isLocal =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".local");

      const isStagingWhitelisted =
        process.env.ALLOW_REMOTE_STAGING === "true" &&
        (host.includes("staging") || host.includes("dev"));

      if (!isLocal && !isStagingWhitelisted) {
        throw new Error(
          `[SAFEGUARD ABORT] Target URL '${targetUrl}' is not a permitted local or staging address. Refusing remote load testing without ALLOW_REMOTE_STAGING=true.`
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("[SAFEGUARD ABORT]")) {
        throw err;
      }
      throw new Error(`[SAFEGUARD ABORT] Invalid target URL '${targetUrl}'.`);
    }
  }

  // 3. Database URI safeguard
  const rawDbUri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || "";
  if (!rawDbUri) {
    throw new Error(
      "[SAFEGUARD ABORT] No database URI configured. Set MONGODB_TEST_URI or MONGODB_URI."
    );
  }

  const lowerUri = rawDbUri.toLowerCase();
  if (
    (lowerUri.includes("prod") || lowerUri.includes("production")) &&
    process.env.ALLOW_PROD_DB !== "true"
  ) {
    throw new Error(
      `[SAFEGUARD ABORT] Database URI '${maskMongoUri(
        rawDbUri
      )}' appears to reference a production database. Refusing execution.`
    );
  }
}

export function resolveDedicatedTestDbUri(): string {
  if (process.env.MONGODB_TEST_URI) {
    return process.env.MONGODB_TEST_URI;
  }

  const baseUri = process.env.MONGODB_URI || "";
  if (!baseUri) {
    throw new Error("MONGODB_URI is required to derive the test database URI.");
  }

  try {
    const parsed = new URL(baseUri);
    // Explicitly scope load-test collections into an isolated database
    parsed.pathname = "/nexamind_loadtest";
    return parsed.toString();
  } catch {
    // If not a standard URL, append or replace database name safely
    return baseUri.replace(/\/([^/?]+)(\?|$)/, "/nexamind_loadtest$2");
  }
}

export function parseLoadTestCliArgs(): LoadTestConfig {
  const args = process.argv.slice(2);
  const getArgValue = (prefix: string): string | undefined => {
    const item = args.find((a) => a.startsWith(prefix));
    return item ? item.slice(prefix.length).trim() : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const scenarioArg = (getArgValue("--scenario=") || "all").toLowerCase();
  const validScenarios: LoadTestConfig["scenario"][] = [
    "all",
    "chat",
    "agent",
    "voice",
    "credit",
  ];
  const scenario: LoadTestConfig["scenario"] = validScenarios.includes(
    scenarioArg as any
  )
    ? (scenarioArg as any)
    : "all";

  const baseline = hasFlag("--baseline");
  const realProviders = hasFlag("--real-providers");

  if (realProviders && process.env.ALLOW_REAL_PROVIDER_LOAD_TEST !== "true") {
    throw new Error(
      "[SAFEGUARD ABORT] Real-provider load testing requires explicit confirmation: set ALLOW_REAL_PROVIDER_LOAD_TEST=true."
    );
  }

  const targetUrl = getArgValue("--url=");
  validateEnvironmentSafeguards(targetUrl);

  const testDbUri = resolveDedicatedTestDbUri();

  // Parse custom concurrency tiers or use baseline/standard defaults
  const customChatTiers = getArgValue("--chat-concurrency=")
    ?.split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const customAgentTiers = getArgValue("--agent-concurrency=")
    ?.split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const customVoiceTiers = getArgValue("--voice-concurrency=")
    ?.split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const customCredit = parseInt(getArgValue("--credit-concurrency=") || "", 10);
  const customVoiceMb = parseFloat(getArgValue("--audio-size-mb=") || "");

  return {
    scenario,
    baseline,
    realProviders,
    targetUrl,
    chatConcurrencyTiers: customChatTiers || (baseline ? [2, 5] : [5, 10, 25, 50]),
    agentConcurrencyTiers: customAgentTiers || (baseline ? [2] : [2, 5, 10]),
    voiceConcurrencyTiers: customVoiceTiers || (baseline ? [1, 2] : [1, 5, 10, 20]),
    creditConcurrencyCount: Number.isFinite(customCredit) && customCredit > 0
      ? customCredit
      : baseline
      ? 5
      : 20,
    voiceAudioSizeMB: Number.isFinite(customVoiceMb) && customVoiceMb > 0
      ? customVoiceMb
      : 5,
    chunkDelayMs: parseInt(getArgValue("--chunk-delay=") || "15", 10),
    toolDelayMs: parseInt(getArgValue("--tool-delay=") || "25", 10),
    testDbUri,
  };
}
