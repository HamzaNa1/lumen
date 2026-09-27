import { describe, expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { createLogger } from "../../apps/server/src/core/Logger";
import { backgroundTask } from "../../apps/server/src/jobs/JobLogging";

describe("production logger", () => {
  test("writes JSON with severity, identity, timestamps and isolated child fields", () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      write: (line) => {
        lines.push(line);
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
    const logger = createLogger("debug", {
      write: (line) => {
        lines.push(line);
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
    const logger = createLogger("debug", {
      write: (line) => {
        lines.push(line);
      },
    });
    const cause = new Error("sensitive");
    cause.cause = cause;
    const fields: { long: string; circular?: object } = { long: "x".repeat(100_000) };
    fields.circular = fields;
    logger.error("bounded", fields as never, cause);
    expect(lines[0].length).toBeLessThan(4_000);
    expect(lines[0]).toContain("TRUNCATED");
    const broken = createLogger("info", {
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => broken.error("still_running")).not.toThrow();
  });

  test("rate limits polling failures, counts them, and reports recovery and a new outage", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createLogger("info", {
      write: (line) => {
        records.push(JSON.parse(line));
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
