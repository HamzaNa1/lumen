import { Context } from "effect";
import pino, { type DestinationStream } from "pino";
import { version } from "../../package.json";
import type { ServerConfig } from "../config/Config";

export type LogLevel = ServerConfig["logLevel"];
export interface LogFields {
  readonly [key: string]: string | number | boolean | null | undefined | LogFields;
}
type Log = (event: string, fields?: LogFields, error?: unknown) => void;

export interface Logger {
  readonly debug: Log;
  readonly info: Log;
  readonly warn: Log;
  readonly error: Log;
  readonly child: (fields: LogFields) => Logger;
}

const sensitiveField =
  /password|secret|token|authorization|cookie|grant$|api.?key|body|headers|path$|url$|query|username/i;
const reservedFields = new Set(["level", "time", "pid", "service", "version", "event", "error"]);

const safeFields = (fields: LogFields): LogFields => {
  let remaining = 64;
  const visit = (fields: LogFields, depth: number): LogFields => {
    const result: Record<string, LogFields[string]> = Object.create(null);
    for (const key of Object.keys(fields)) {
      if (remaining-- <= 0) break;
      if (reservedFields.has(key)) continue;
      if (sensitiveField.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      const value = fields[key];
      result[key] =
        typeof value === "string"
          ? value.slice(0, 256)
          : typeof value === "object" && value !== null
            ? depth < 3
              ? visit(value, depth + 1)
              : "[TRUNCATED]"
            : value;
    }
    return result;
  };
  return visit(fields, 0);
};

// Database, validation, subprocess and network errors can embed SQL parameters,
// credentials, URLs or media names in their messages. Retain only diagnostics
// that do not require copying that free-form text into production logs.
const errorDetails = (error: unknown, depth = 0): unknown => {
  if (depth === 4) return { type: "TruncatedCause" };
  if (typeof error !== "object" || error === null) return { type: typeof error };
  const value = error as {
    name?: unknown;
    code?: unknown;
    _tag?: unknown;
    operation?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[\w.-]{1,64}$/u.test(value) ? value : undefined;
  return {
    type: identifier(value._tag) ?? identifier(value.name) ?? "UnknownError",
    code: identifier(value.code),
    operation: identifier(value.operation),
    // Extract source locations, not the first stack line (which contains the message).
    frames:
      typeof value.stack === "string"
        ? value.stack
            .slice(0, 16_384)
            .split("\n")
            .filter((line) => /^\s+at /u.test(line))
            .map((line) => /(?:^|[/\\])([\w.-]+:\d+:\d+)\)?$/u.exec(line)?.[1])
            .filter((frame) => frame !== undefined)
            .slice(0, 12)
        : undefined,
    cause: value.cause === undefined ? undefined : errorDetails(value.cause, depth + 1),
  };
};

export const createLogger = (level: LogLevel = "info", destination?: DestinationStream): Logger => {
  // Synchronous stdout applies backpressure without an unbounded in-process
  // queue, and needs no asynchronous flush when the process terminates.
  const stdout = destination === undefined ? pino.destination({ dest: 1, sync: true }) : undefined;
  stdout?.on("error", () => undefined);
  const output = pino(
    {
      level,
      base: { service: "lumen-server", version, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination ?? stdout,
  );
  const wrap = (bindings: LogFields): Logger => {
    const log =
      (level: LogLevel): Log =>
      (event, fields = {}, error) => {
        if (!output.isLevelEnabled(level)) return;
        try {
          output[level]({
            ...bindings,
            ...safeFields(fields),
            event,
            ...(error === undefined ? {} : { error: errorDetails(error) }),
          });
        } catch {
          // A broken log destination or malformed diagnostic must not fail work.
        }
      };
    return {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      child: (fields) => wrap({ ...bindings, ...safeFields(fields) }),
    };
  };
  return wrap({});
};

export const ServerLogger = Context.Reference<Logger>("@lumen/server/Logger", {
  defaultValue: () => createLogger(),
});
