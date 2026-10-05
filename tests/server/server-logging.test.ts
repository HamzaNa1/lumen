import { describe, expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { internal, unauthorized } from "../../apps/server/src/core/Errors";
import { createLogger } from "../../apps/server/src/core/Logger";
import { makeHttpHandler, type HttpServices } from "../../apps/server/src/http/HttpApp";
import { startServer } from "../../apps/server/src/Runtime";

const capture = (level: "debug" | "info" | "warn" | "error" = "info") => {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    logger: createLogger({
      level: level,
      format: "json",
      destination: {
        write: (line) => {
          records.push(JSON.parse(line));
        },
      },
    }),
  };
};

const handler = (
  logging: ReturnType<typeof capture>,
  services: Partial<HttpServices> = {},
  maxRequests = 600,
) =>
  makeHttpHandler(
    {
      auth: {
        setupRequired: () => Effect.succeed(false),
        authenticate: () => Effect.fail(unauthorized()),
      },
      playback: { authorizeGrant: () => Effect.fail(unauthorized()) },
      databaseReady: async () => true,
      ...services,
    } as HttpServices,
    { ...decodeConfig({}), maxRequestsPerMinute: maxRequests },
    logging.logger,
  );

describe("HTTP and lifecycle logging", () => {
  test("correlates concurrent requests and every response without logging credentials or queries", async () => {
    const logging = capture();
    const fetch = handler(logging);
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const response = await fetch(
          new Request("http://localhost/api/v1/auth/setup?token=private-query", {
            headers: {
              "x-request-id": id,
              authorization: "Bearer private-token",
              cookie: "private-cookie",
            },
          }),
        );
        expect(response.headers.get("x-request-id")).toBe(id);
        expect(logging.records.filter((record) => record.requestId === id)).toHaveLength(1);
      }),
    );
    expect(logging.records).toHaveLength(20);
    expect(JSON.stringify(logging.records)).not.toContain("private-");
    for (const record of logging.records) {
      expect(record).toMatchObject({
        event: "http_request",
        level: "info",
        status: 200,
        route: "/api/v1/auth/setup",
      });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns a safe request ID and logs auth failures, validation errors and rate limits once", async () => {
    const logging = capture();
    const fetch = handler(logging, {}, 1);
    const denied = await fetch(
      new Request("http://localhost/api/v1/media/private-title?grant=private-grant", {
        headers: { "x-request-id": "private-invalid-id" },
      }),
    );
    expect(denied.status).toBe(401);
    expect((await denied.json()).requestId).toBe(denied.headers.get("x-request-id"));
    expect((await fetch(new Request("http://localhost/api/v1/items/private-title"))).status).toBe(
      401,
    );
    const limited = await fetch(new Request("http://localhost/api/v1/items/private-title"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await limited.json()).requestId).toBe(limited.headers.get("x-request-id"));
    const invalid = await handler(logging)(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "private-password" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(logging.records.map(({ level, status }) => [level, status])).toEqual([
      ["warn", 401],
      ["warn", 401],
      ["warn", 429],
      ["warn", 400],
    ]);
    expect(logging.records[0].route).toBe("/api/v1/media/:id");
    expect(JSON.stringify(logging.records)).not.toContain("private-");
  });

  test("logs internal failures safely and keeps healthy probes at debug", async () => {
    const logging = capture();
    await handler(logging)(new Request("http://localhost/health/live"));
    expect(logging.records).toHaveLength(0);
    await handler(logging, { databaseReady: async () => false })(
      new Request("http://localhost/ready"),
    );
    const fetch = handler(logging, {
      auth: {
        setupRequired: () => Effect.fail(internal("private-message", new Error("private-SQL"))),
      } as HttpServices["auth"],
    });
    const response = await fetch(new Request("http://localhost/api/v1/auth/setup"));
    expect(response.status).toBe(500);
    expect(logging.records.map(({ level, status }) => [level, status])).toEqual([
      ["error", 503],
      ["error", 500],
    ]);
    expect(logging.records[1]).toMatchObject({
      errorCode: "internal",
      error: { type: "ServerError", cause: { type: "Error" } },
    });
    expect(JSON.stringify(logging.records)).not.toContain("private-");
    const debug = capture("debug");
    await handler(debug)(new Request("http://localhost/health/live"));
    expect(debug.records[0].level).toBe("debug");
  });

  test("logs streaming response setup without reading or buffering the stream", async () => {
    const logging = capture();
    let pulls = 0;
    const stream = new ReadableStream(
      {
        pull: () => {
          pulls += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = handler(logging, {
      auth: {
        authenticate: () => Effect.succeed({ user: { id: "user" } }),
      } as HttpServices["auth"],
      events: { stream: () => stream } as unknown as HttpServices["events"],
    });
    const response = await fetch(
      new Request("http://localhost/api/v1/events", {
        headers: { authorization: "Bearer private" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe(stream);
    expect(pulls).toBe(0);
    expect(logging.records).toHaveLength(1);
    await response.body?.cancel();
  });

  test("captures real server startup, background services and idempotent shutdown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lumen-logs-"));
    const logging = capture();
    try {
      const running = await startServer(
        {
          host: "127.0.0.1",
          port: 0,
          dataDir: workspace,
          databasePath: join(workspace, "server.sqlite"),
        },
        logging.logger,
      );
      try {
        const response = await fetch(new URL("/api/v1/auth/setup", running.server.url));
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBeString();
      } finally {
        await Promise.all([running.stop(), running.stop()]);
      }
      const events = logging.records.map(({ event }) => event);
      for (const event of [
        "server_starting",
        "server_listening",
        "job_worker_started",
        "scheduler_started",
        "http_request",
        "server_stopping",
        "job_worker_stopped",
        "scheduler_stopped",
        "server_stopped",
      ]) {
        expect(events.filter((value) => value === event)).toHaveLength(1);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reports initialization failure promptly and safely", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lumen-logs-failure-"));
    const logging = capture();
    try {
      const databasePath = join(workspace, "server.sqlite");
      await writeFile(databasePath, "invalid database private-content");
      await expect(
        startServer(
          { host: "127.0.0.1", port: 0, dataDir: workspace, databasePath },
          logging.logger,
        ),
      ).rejects.toBeDefined();
      expect(logging.records.filter(({ event }) => event === "server_start_failed")).toHaveLength(
        1,
      );
      expect(JSON.stringify(logging.records)).not.toContain(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
