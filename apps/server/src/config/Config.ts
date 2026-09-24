import { Schema } from "effect";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
try {
  process.loadEnvFile(join(workspaceRoot, ".env"));
} catch {
}

const Numeric = Schema.String.check(Schema.isPattern(/^\d+$/u));
const Port = Numeric;
const LogLevel = Schema.Literals(["debug", "info", "warn", "error"]);
const Environment = Schema.Struct({
  LUMEN_HOST: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  LUMEN_PORT: Schema.optional(Port),
  LUMEN_DATABASE_PATH: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  LUMEN_DATA_DIR: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  LUMEN_LOG_LEVEL: Schema.optional(LogLevel),
  LUMEN_ACCESS_TOKEN_TTL_MS: Schema.optional(Numeric),
  LUMEN_REFRESH_TOKEN_TTL_MS: Schema.optional(Numeric),
  LUMEN_MAX_REQUEST_BODY_BYTES: Schema.optional(Numeric),
  LUMEN_MAX_CONCURRENT_REQUESTS: Schema.optional(Numeric),
  LUMEN_MAX_REQUESTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_LOGIN_ATTEMPTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_MAX_EVENT_ID: Schema.optional(Numeric),
  LUMEN_SCAN_LEASE_MS: Schema.optional(Numeric),
  LUMEN_FFPROBE_TIMEOUT_MS: Schema.optional(Numeric),
  LUMEN_FFPROBE_MAX_OUTPUT_BYTES: Schema.optional(Numeric),
  LUMEN_SHUTDOWN_GRACE_MS: Schema.optional(Numeric),
  LUMEN_HEARTBEAT_INTERVAL_MS: Schema.optional(Numeric),
  LUMEN_TMDB_API_KEY: Schema.optional(Schema.String),
});

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly accessTokenTtlMs: number;
  readonly refreshTokenTtlMs: number;
  readonly maxRequestBodyBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxRequestsPerMinute: number;
  readonly loginAttemptsPerMinute: number;
  readonly maxEventId: number;
  readonly scanLeaseMs: number;
  readonly ffprobeTimeoutMs: number;
  readonly ffprobeMaxOutputBytes: number;
  readonly shutdownGraceMs: number;
  readonly heartbeatIntervalMs: number;
  readonly tmdbApiKey: string | null;
}

const toInteger = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

const toBoundedInteger = (name: string, raw: string | undefined, fallback: number, minimum: number, maximum: number): number => {
  const value = toInteger(name, raw, fallback);
  if (value < minimum || value > maximum) throw new Error(`${name} is outside its allowed range`);
  return value;
};

const resolveWorkspacePath = (value: string): string => isAbsolute(value) ? value : resolve(workspaceRoot, value);

export const decodeConfig = (environment: Record<string, string | undefined>): ServerConfig => {
  const parsed = Schema.decodeUnknownSync(Environment)(environment);
  const databasePath = resolveWorkspacePath(parsed.LUMEN_DATABASE_PATH ?? "./data/lumen.sqlite");
  const dataDir = resolveWorkspacePath(parsed.LUMEN_DATA_DIR ?? "./data");
  return {
    host: parsed.LUMEN_HOST ?? "127.0.0.1",
    port: toBoundedInteger("LUMEN_PORT", parsed.LUMEN_PORT, 3210, 1, 65_535),
    databasePath,
    dataDir,
    logLevel: parsed.LUMEN_LOG_LEVEL ?? "info",
    accessTokenTtlMs: toBoundedInteger("LUMEN_ACCESS_TOKEN_TTL_MS", parsed.LUMEN_ACCESS_TOKEN_TTL_MS, 900_000, 60_000, 86_400_000),
    refreshTokenTtlMs: toBoundedInteger("LUMEN_REFRESH_TOKEN_TTL_MS", parsed.LUMEN_REFRESH_TOKEN_TTL_MS, 2_592_000_000, 300_000, 31_536_000_000),
    maxRequestBodyBytes: toBoundedInteger("LUMEN_MAX_REQUEST_BODY_BYTES", parsed.LUMEN_MAX_REQUEST_BODY_BYTES, 1_048_576, 1_024, 100_000_000),
    maxConcurrentRequests: toBoundedInteger("LUMEN_MAX_CONCURRENT_REQUESTS", parsed.LUMEN_MAX_CONCURRENT_REQUESTS, 128, 1, 10_000),
    maxRequestsPerMinute: toBoundedInteger("LUMEN_MAX_REQUESTS_PER_MINUTE", parsed.LUMEN_MAX_REQUESTS_PER_MINUTE, 600, 1, 1_000_000),
    loginAttemptsPerMinute: toBoundedInteger("LUMEN_LOGIN_ATTEMPTS_PER_MINUTE", parsed.LUMEN_LOGIN_ATTEMPTS_PER_MINUTE, 10, 1, 1_000_000),
    maxEventId: toBoundedInteger("LUMEN_MAX_EVENT_ID", parsed.LUMEN_MAX_EVENT_ID, 65_536, 1, 100_000_000),
    scanLeaseMs: toBoundedInteger("LUMEN_SCAN_LEASE_MS", parsed.LUMEN_SCAN_LEASE_MS, 300_000, 1_000, 86_400_000),
    ffprobeTimeoutMs: toBoundedInteger("LUMEN_FFPROBE_TIMEOUT_MS", parsed.LUMEN_FFPROBE_TIMEOUT_MS, 15_000, 100, 600_000),
    ffprobeMaxOutputBytes: toBoundedInteger("LUMEN_FFPROBE_MAX_OUTPUT_BYTES", parsed.LUMEN_FFPROBE_MAX_OUTPUT_BYTES, 1_048_576, 1_024, 100_000_000),
    shutdownGraceMs: toBoundedInteger("LUMEN_SHUTDOWN_GRACE_MS", parsed.LUMEN_SHUTDOWN_GRACE_MS, 10_000, 100, 600_000),
    heartbeatIntervalMs: toBoundedInteger("LUMEN_HEARTBEAT_INTERVAL_MS", parsed.LUMEN_HEARTBEAT_INTERVAL_MS, 20_000, 1_000, 600_000),
    tmdbApiKey: parsed.LUMEN_TMDB_API_KEY?.trim() || null,
  };
};
