import type { LogFields, LogLevel } from "./Logger";

const messages: Readonly<Record<string, string>> = {
  server_starting: "Starting Lumen server version {version}",
  server_listening: "Listening on {host}:{port} (started in {durationMs})",
  server_start_failed: "Server failed to start",
  server_stopping: "Stopping Lumen server",
  server_stopped: "Server stopped after {durationMs}",
  server_stop_failed: "Server failed to shut down cleanly",
  database_migration_started: "Applying database migrations",
  database_migration_completed: "Database migrations completed",
  database_migration_failed: "Database migration failed",
  http_request: "{method} {route} responded {status} in {durationMs}",
  job_worker_started: "Background job worker started",
  job_worker_stopped: "Background job worker stopped",
  scheduler_started: "Scheduled task manager started",
  scheduler_stopped: "Scheduled task manager stopped",
  scheduled_job_started: "Running scheduled task: {operation}",
  scheduled_job_finished: "Scheduled task {operation} {result} after {durationMs}",
  job_started: "Running {operation} (attempt {attempt}/{maxAttempts})",
  job_succeeded: "{operation} completed after {durationMs}",
  job_retry_scheduled:
    "{operation} failed on attempt {attempt}/{maxAttempts}; retrying in {retryDelayMs}",
  job_failed:
    "{operation} failed after {durationMs} (attempt {attempt}/{maxAttempts}); no retries remaining",
  job_leases_recovered: "Recovered {count} expired job leases",
  metadata_backfill_queued: "Queued metadata refresh for {count} media sources",
  background_task_failed: "{operation} failed ({failures} consecutive failures)",
  background_task_recovered: "{operation} recovered after {failures} failures",
  background_service_failed: "Background service stopped unexpectedly",
  scan_run_queued: "Queued {mode} library scan across {roots} roots",
  scan_run_finished: "Library scan {result}",
  scan_cleanup_completed:
    "Scan cleanup completed; removed {sourcesDeleted} sources and {itemsDeleted} items",
  scan_cleanup_skipped: "Skipping scan cleanup: {reason}",
  artwork_sweep_completed: "Artwork cleanup completed; removed {filesDeleted} unused files",
  catalog_path_unmatched: "Could not identify media from its location: {reason}",
  library_deleted: "Library deletion {result}",
  library_root_deleted: "Library root deletion {result}",
  event_stream_read_failed: "Failed to read updates for the event stream",
};

const sources: Readonly<Record<string, string>> = {
  http: "Lumen.Server.Http",
  jobs: "Lumen.Server.Jobs.Worker",
  worker: "Lumen.Server.Jobs.Worker",
  scheduler: "Lumen.Server.Jobs.TaskManager",
  scanner: "Lumen.Server.Library.Scanner",
  ingest: "Lumen.Server.Library.MediaIngest",
  libraries: "Lumen.Server.Library.LibraryManager",
  events: "Lumen.Server.Events",
  database: "Lumen.Server.Database.Migrations",
};

const operations: Readonly<Record<string, string>> = {
  "library-watcher": "Library monitor",
  "artwork-sweep": "Artwork cleanup",
  discover: "Media discovery",
  probe: "Media inspection",
  metadata: "Metadata refresh",
  cleanup: "Library cleanup",
  artwork: "Artwork generation",
  analyze: "Media analysis",
  metadata_backfill: "Metadata backfill",
  job_recovery: "Expired job recovery",
  job_dispatch: "Job dispatch",
  scheduled_jobs: "Scheduled tasks",
};

const labels: Readonly<Record<LogLevel, string>> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};
const metadataKeys = new Set([
  "level",
  "time",
  "pid",
  "service",
  "version",
  "component",
  "source",
  "event",
  "msg",
  "error",
]);

const words = (text: string): string => text.replaceAll("_", " ").replaceAll("-", " ");
const lookup = (values: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(values, key) ? values[key] : undefined;
const duration = (value: number): string => {
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) {
    const seconds = Number((value / 1_000).toFixed(2));
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
};

const displayValue = (key: string, value: unknown): string => {
  if (value === undefined || value === null) return "unknown";
  if (key.endsWith("Ms") && typeof value === "number") return duration(value);
  if (key === "operation" && typeof value === "string")
    return lookup(operations, value) ?? words(value);
  if ((key === "reason" || key === "errorCode") && typeof value === "string") return words(value);
  if (key === "result" && value === "succeeded") return "completed";
  if (key === "result" && value === "not_found") return "skipped (not found)";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([name, count]) => `${name}: ${displayValue(name, count)}`)
      .join(", ");
  return String(value);
};

export const logSource = (component: LogFields[string]): string =>
  typeof component === "string" ? (lookup(sources, component) ?? "Lumen.Server") : "Lumen.Server";

export const logMessage = (event: string, fields: LogFields): string =>
  lookup(messages, event)?.replace(/\{(\w+)\}/gu, (_, key: string) =>
    displayValue(key, fields[key]),
  ) ?? words(event).replace(/^./u, (letter) => letter.toUpperCase());

interface ErrorDetails {
  readonly type: string;
  readonly code?: string;
  readonly operation?: string;
  readonly frames?: readonly string[];
  readonly cause?: ErrorDetails;
}

interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly pid: number;
  readonly source: string;
  readonly event: string;
  readonly msg: string;
  readonly error?: ErrorDetails;
  readonly [key: string]: unknown;
}

const formatError = (error: ErrorDetails): string =>
  [
    error.type,
    error.code === undefined ? "" : ` (${error.code})`,
    error.operation === undefined ? "" : ` during ${error.operation}`,
    error.frames?.length ? ` at ${error.frames.join(" <- ")}` : "",
    error.cause === undefined ? "" : `; caused by ${formatError(error.cause)}`,
  ].join("");

// Escape control characters in the rendered line so diagnostic values cannot
// inject extra records, terminal escape sequences or misleading line breaks.
const singleLine = (value: string): string =>
  value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export const formatTextLog = (record: LogRecord): string => {
  const date = new Date(record.time);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const usedFields = new Set(
    Array.from((lookup(messages, record.event) ?? "").matchAll(/\{(\w+)\}/gu), (match) => match[1]),
  );
  const context = Object.entries(record)
    .filter(
      ([key, value]) =>
        !metadataKeys.has(key) && !usedFields.has(key) && value !== undefined && value !== null,
    )
    .map(([key, value]) => `${key[0].toUpperCase()}${key.slice(1)}: ${displayValue(key, value)}`);
  const details = context.length === 0 ? "" : ` (${context.join("; ")})`;
  const error = record.error === undefined ? "" : `. Error: ${formatError(record.error)}`;
  return `${singleLine(`[${time}] [${labels[record.level]}] [${record.pid}] ${record.source}: ${record.msg}${details}${error}`)}\n`;
};
