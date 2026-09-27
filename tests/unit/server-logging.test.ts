import { describe, expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { createLogger } from "../../apps/server/src/core/Logger";
import { backgroundTask } from "../../apps/server/src/jobs/JobLogging";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { formatTextLog } from "../../apps/server/src/core/LogFormatting";

describe("production logger", () => {
  test("defaults to readable local-time lines with short levels and source names", () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    logger.debug("job_started");
    logger.info("server_starting");
    logger.child({ component: "http", requestId: "request-1" }).warn("http_request", {
      method: "GET",
      route: "/api/v1/items/:id",
      status: 401,
      durationMs: 2.5,
      errorCode: "unauthorized",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] \[INF\] \[Server\] Starting Lumen server version [0-9.]+\n$/u,
    );
    expect(lines[1]).toContain("[WRN] [HTTP] GET /api/v1/items/:id responded 401 in 2.5 ms");
    expect(lines[1]).toContain("RequestId: request-1");
    expect(lines[1]).not.toContain("http_request");
    expect(lines[1]).not.toContain('"level"');
    expect(lines.every((line) => !line.includes(`[${process.pid}]`))).toBe(true);
    const time = new Date(2026, 8, 28, 1, 50, 50);
    expect(
      formatTextLog({
        time: time.toISOString(),
        level: "info",
        pid: 36,
        source: "Server",
        event: "server_starting",
        msg: "Starting Lumen server",
      }),
    ).toBe("[01:50:50] [INF] [Server] Starting Lumen server\n");
  });

  test("renders task names, elapsed time and cleanup counts as readable messages", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    logger
      .child({ component: "jobs" })
      .debug("job_succeeded", { operation: "metadata", durationMs: 78_000 });
    logger
      .child({ component: "scanner" })
      .info("scan_cleanup_completed", { sourcesDeleted: 3, itemsDeleted: 2 });
    logger.child({ component: "scheduler" }).warn("job_retry_scheduled", {
      operation: "library-watcher",
      attempt: 1,
      maxAttempts: 3,
      retryDelayMs: 2_000,
    });
    expect(lines[0]).toContain("[DBG]");
    expect(lines[0]).toContain(
      "[Jobs/Worker] Metadata refresh completed after 1 minute 18 seconds",
    );
    expect(lines[1]).toContain(
      "[Library/Scanner] Scan cleanup completed; removed 3 sources and 2 items",
    );
    expect(lines[2]).toContain(
      "[Jobs/Scheduler] Library monitor failed on attempt 1/3; retrying in 2 seconds",
    );
    expect(lines.every((line) => line.split("\n").length === 2)).toBe(true);
  });

  test("redacts text output and escapes values that could forge terminal log lines", () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    logger.child({ component: "database" }).error(
      "database_migration_failed",
      {
        accessToken: "private-token",
        requestId: "one\n[INF] forged\r\u001b[31m\u2028\u202e",
        source: "spoofed",
        msg: "spoofed",
        nested: { password: "private-password" },
      },
      Object.assign(new Error("private-error"), { code: "SQLITE_BUSY" }),
    );
    expect(lines[0]).toContain("[ERR]");
    expect(lines[0]).toContain("[Database/Migrations] Database migration failed");
    expect(lines[0]).toContain("Error: Error (SQLITE_BUSY)");
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines[0]).toContain("\\u001b");
    expect(lines[0]).toContain("\\u2028");
    expect(lines[0]).toContain("\\u202e");
    expect(lines[0]).not.toContain("private-");
    expect(lines[0]).not.toContain("spoofed");
    expect(lines[0].split("\n")).toHaveLength(2);
    const broken = createLogger({
      destination: {
        write: () => {
          throw new Error("EPIPE");
        },
      },
    });
    expect(() => broken.error("server_start_failed")).not.toThrow();
  });

  test("validates the optional JSON format and defaults configuration to text", () => {
    expect(decodeConfig({}).logFormat).toBe("text");
    expect(decodeConfig({ LUMEN_LOG_FORMAT: "json" }).logFormat).toBe("json");
    expect(() => decodeConfig({ LUMEN_LOG_FORMAT: "pretty" })).toThrow();
  });

  test("writes JSON with severity, identity, timestamps and isolated child fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      format: "json",
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    logger.debug("hidden");
    logger.child({ requestId: "one" }).info("request", { status: 200 });
    logger.child({ requestId: "two" }).warn("request", { status: 401 });
    logger.error("failure", { level: "debug", event: "spoofed", service: "spoofed" });
    expect(lines).toHaveLength(3);
    const records = lines.map((line) => JSON.parse(line));
    expect(records.map(({ level }) => level)).toEqual(["info", "warn", "error"]);
    expect(records.map(({ requestId }) => requestId)).toEqual(["one", "two", undefined]);
    expect(records[2]).toMatchObject({ service: "lumen-server", event: "failure" });
    for (const record of records) {
      expect(record.pid).toBe(process.pid);
      expect(record.version).toBeString();
      expect(new Date(record.time).toISOString()).toBe(record.time);
    }
    expect(lines.every((line) => line.split("\n").length === 2)).toBe(true);
  });

  test("redacts sensitive fields and omits error messages, SQL, paths and arbitrary causes", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    const nested = Object.assign(new Error("password=hunter2"), { code: "SQLITE_BUSY" });
    nested.stack = "Error: password=hunter2\n    at query (/private/media-name/Database.ts:10:20)";
    const error = new Error("SELECT secret FROM users WHERE token='hunter2'", { cause: nested });
    error.stack = "Error: hunter2\n    at serve (/private/account-name/HttpApp.ts:12:34)";
    logger.child({ accessToken: "hunter2" }).error(
      "request_failed",
      {
        Authorization: "Bearer hunter2",
        refreshToken: "hunter2",
        grant: "hunter2",
        requestBody: "hunter2",
        apiKey: "hunter2",
        relativePath: "private/media-name",
        nested: { credentials: { password: "hunter2" } },
      },
      error,
    );
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain("SELECT");
    expect(lines[0]).not.toContain("private");
    expect(JSON.parse(lines[0]).error).toEqual({
      type: "Error",
      frames: ["HttpApp.ts:12:34"],
      cause: { type: "Error", code: "SQLITE_BUSY", frames: ["Database.ts:10:20"] },
    });
  });

  test("bounds circular fields and causes and tolerates a failed destination", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    const cause = new Error("sensitive");
    cause.cause = cause;
    const fields: { long: string; circular?: object } = { long: "x".repeat(100_000) };
    fields.circular = fields;
    logger.error("bounded", fields as never, cause);
    expect(lines[0].length).toBeLessThan(4_000);
    expect(lines[0]).toContain("TRUNCATED");
    const broken = createLogger({
      level: "info",
      format: "json",
      destination: {
        write: () => {
          throw new Error("EPIPE");
        },
      },
    });
    expect(() => broken.error("still_running")).not.toThrow();
  });

  test("rate limits polling failures, counts them, and reports recovery and a new outage", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: "info",
      format: "json",
      destination: {
        write: (line) => {
          records.push(JSON.parse(line));
        },
      },
    });
    let now = 1_000;
    let failing = true;
    const run = backgroundTask(
      logger,
      "job_recovery",
      () => (failing ? Effect.die(new Error("private database error")) : Effect.succeed(10)),
      0,
      () => now,
    );
    for (let index = 0; index < 100; index += 1) expect(await run()).toBe(0);
    expect(records).toHaveLength(1);
    now += 30_000;
    await run();
    failing = false;
    expect(await run()).toBe(10);
    failing = true;
    await run();
    expect(records.map(({ event, failures }) => [event, failures])).toEqual([
      ["background_task_failed", 1],
      ["background_task_failed", 101],
      ["background_task_recovered", 101],
      ["background_task_failed", 1],
    ]);
  });
});
