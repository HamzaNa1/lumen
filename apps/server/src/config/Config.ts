import { normalizeAddress } from "../http/ClientIdentity";
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
  LUMEN_LOG_FORMAT: Schema.optional(Schema.Literals(["text", "json"])),
  LUMEN_MAX_REQUEST_BODY_BYTES: Schema.optional(Numeric),
  LUMEN_MAX_CONCURRENT_REQUESTS: Schema.optional(Numeric),
  LUMEN_MAX_REQUESTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_LOGIN_ATTEMPTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_MEDIA_PEER_REQUESTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_MEDIA_BURST: Schema.optional(Numeric),
  LUMEN_MEDIA_REQUESTS_PER_MINUTE: Schema.optional(Numeric),
  LUMEN_MEDIA_MAX_CONCURRENT_SETUPS: Schema.optional(Numeric),
  LUMEN_MEDIA_MAX_GLOBAL_SETUPS: Schema.optional(Numeric),
  LUMEN_MAX_EVENT_ID: Schema.optional(Numeric),
  LUMEN_SCAN_LEASE_MS: Schema.optional(Numeric),
  LUMEN_LIBRARY_WATCH_INTERVAL_MS: Schema.optional(Numeric),
  LUMEN_FFPROBE_TIMEOUT_MS: Schema.optional(Numeric),
  LUMEN_FFPROBE_MAX_OUTPUT_BYTES: Schema.optional(Numeric),
  LUMEN_SHUTDOWN_GRACE_MS: Schema.optional(Numeric),
  LUMEN_HEARTBEAT_INTERVAL_MS: Schema.optional(Numeric),
  LUMEN_WEB_ROOT: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  LUMEN_WEB_APP: Schema.optional(Schema.Literals(["required", "optional"])),
  LUMEN_COOKIE_SECURE: Schema.optional(Schema.Literals(["auto", "always", "never"])),
  LUMEN_TRUSTED_PROXIES: Schema.optional(Schema.String),
  LUMEN_ALLOWED_ORIGINS: Schema.optional(Schema.String),
  NODE_ENV: Schema.optional(Schema.String),
});

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logFormat: "text" | "json";
  readonly maxRequestBodyBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxRequestsPerMinute: number;
  readonly loginAttemptsPerMinute: number;
  /** Provisional media admission profile; concurrency counts response setup, never live transfers. */
  readonly mediaPeerRequestsPerMinute: number;
  readonly mediaBurst: number;
  readonly mediaRequestsPerMinute: number;
  readonly mediaMaxConcurrentSetups: number;
  readonly mediaMaxGlobalSetups: number;
  readonly maxEventId: number;
  readonly scanLeaseMs: number;
  readonly libraryWatchIntervalMs: number;
  readonly ffprobeTimeoutMs: number;
  readonly ffprobeMaxOutputBytes: number;
  readonly shutdownGraceMs: number;
  readonly heartbeatIntervalMs: number;
  /** The built browser app, served under /web. */
  readonly webRoot: string;
  /** Whether the server refuses to start without the browser app. */
  readonly webApp: "required" | "optional";
  /**
   * When the browser session cookie is marked Secure. "auto" follows the request: Secure over
   * HTTPS, and not over the plain HTTP of local development or a home network, where a Secure
   * cookie would never be sent back.
   */
  readonly cookieSecure: "auto" | "always" | "never";
  /** Origins, besides the one a request arrives on, whose pages may use a browser session. */
  /** Exact socket proxy IP addresses permitted to supply forwarding chains. */
  readonly trustedProxies: ReadonlyArray<string>;
  readonly allowedOrigins: ReadonlyArray<string>;
}

const toOrigins = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => {
      const url = new URL(value);
      if (url.origin === "null" || `${url.origin}/` !== url.href)
        throw new Error("LUMEN_ALLOWED_ORIGINS must list origins such as https://media.example");
      return url.origin;
    });

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
    logFormat: parsed.LUMEN_LOG_FORMAT ?? "text",
    maxRequestBodyBytes: toBoundedInteger("LUMEN_MAX_REQUEST_BODY_BYTES", parsed.LUMEN_MAX_REQUEST_BODY_BYTES, 1_048_576, 1_024, 100_000_000),
    maxConcurrentRequests: toBoundedInteger("LUMEN_MAX_CONCURRENT_REQUESTS", parsed.LUMEN_MAX_CONCURRENT_REQUESTS, 128, 1, 10_000),
    maxRequestsPerMinute: toBoundedInteger("LUMEN_MAX_REQUESTS_PER_MINUTE", parsed.LUMEN_MAX_REQUESTS_PER_MINUTE, 600, 1, 1_000_000),
    loginAttemptsPerMinute: toBoundedInteger("LUMEN_LOGIN_ATTEMPTS_PER_MINUTE", parsed.LUMEN_LOGIN_ATTEMPTS_PER_MINUTE, 10, 1, 1_000_000),
    mediaPeerRequestsPerMinute: toBoundedInteger(
      "LUMEN_MEDIA_PEER_REQUESTS_PER_MINUTE",
      parsed.LUMEN_MEDIA_PEER_REQUESTS_PER_MINUTE,
      1200,
      1,
      100000,
    ),
    mediaBurst: toBoundedInteger("LUMEN_MEDIA_BURST", parsed.LUMEN_MEDIA_BURST, 64, 1, 10000),
    mediaRequestsPerMinute: toBoundedInteger(
      "LUMEN_MEDIA_REQUESTS_PER_MINUTE",
      parsed.LUMEN_MEDIA_REQUESTS_PER_MINUTE,
      600,
      1,
      100000,
    ),
    mediaMaxConcurrentSetups: toBoundedInteger(
      "LUMEN_MEDIA_MAX_CONCURRENT_SETUPS",
      parsed.LUMEN_MEDIA_MAX_CONCURRENT_SETUPS,
      8,
      1,
      1000,
    ),
    mediaMaxGlobalSetups: toBoundedInteger(
      "LUMEN_MEDIA_MAX_GLOBAL_SETUPS",
      parsed.LUMEN_MEDIA_MAX_GLOBAL_SETUPS,
      64,
      1,
      10000,
    ),
    maxEventId: toBoundedInteger("LUMEN_MAX_EVENT_ID", parsed.LUMEN_MAX_EVENT_ID, 65_536, 1, 100_000_000),
    scanLeaseMs: toBoundedInteger("LUMEN_SCAN_LEASE_MS", parsed.LUMEN_SCAN_LEASE_MS, 300_000, 1_000, 86_400_000),
    libraryWatchIntervalMs: toBoundedInteger("LUMEN_LIBRARY_WATCH_INTERVAL_MS", parsed.LUMEN_LIBRARY_WATCH_INTERVAL_MS, 60_000, 1_000, 86_400_000),
    ffprobeTimeoutMs: toBoundedInteger("LUMEN_FFPROBE_TIMEOUT_MS", parsed.LUMEN_FFPROBE_TIMEOUT_MS, 15_000, 100, 600_000),
    ffprobeMaxOutputBytes: toBoundedInteger("LUMEN_FFPROBE_MAX_OUTPUT_BYTES", parsed.LUMEN_FFPROBE_MAX_OUTPUT_BYTES, 1_048_576, 1_024, 100_000_000),
    shutdownGraceMs: toBoundedInteger("LUMEN_SHUTDOWN_GRACE_MS", parsed.LUMEN_SHUTDOWN_GRACE_MS, 10_000, 100, 600_000),
    heartbeatIntervalMs: toBoundedInteger("LUMEN_HEARTBEAT_INTERVAL_MS", parsed.LUMEN_HEARTBEAT_INTERVAL_MS, 20_000, 1_000, 600_000),
    webRoot: resolveWorkspacePath(parsed.LUMEN_WEB_ROOT ?? "./apps/web/dist"),
    // A production server ships with the browser app; a checkout may not have built it yet.
    webApp: parsed.LUMEN_WEB_APP ?? (parsed.NODE_ENV === "production" ? "required" : "optional"),
    cookieSecure: parsed.LUMEN_COOKIE_SECURE ?? "auto",
    trustedProxies: (parsed.LUMEN_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const address = normalizeAddress(value);
        if (address === null) throw new Error("LUMEN_TRUSTED_PROXIES must list IP addresses");
        return address;
      }),
    allowedOrigins: toOrigins(parsed.LUMEN_ALLOWED_ORIGINS),
  };
};
