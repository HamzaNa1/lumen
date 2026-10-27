import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, password, repository, test } from "./support/server";

for (const [key, values] of [
  ["LUMEN_PORT", ["0", "65536"]],
  [
    "LUMEN_MAX_CONCURRENT_REQUESTS",
    ["", "-1", "1.5", "1e3", "NaN", "Infinity", "9007199254740993", "0", "10001"],
  ],
  ["LUMEN_SCAN_LEASE_MS", ["999", "86400001"]],
  ["LUMEN_ALLOWED_ORIGINS", ["https://example.test/path", "null"]],
  ["LUMEN_LOG_FORMAT", ["xml"]],
] as const)
  for (const value of values)
    test(`server CLI rejects ${key}=${JSON.stringify(value)} before listening`, async ({
      playwright: _playwright,
    }, testInfo) => {
      const result = spawnSync(
        "bun",
        [
          "--preload",
          join(repository, "tests/e2e/support/process-coverage.ts"),
          join(repository, "apps/server/src/main.ts"),
        ],
        {
          cwd: repository,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            LUMEN_DATA_DIR: testInfo.outputPath("data"),
            LUMEN_DATABASE_PATH: testInfo.outputPath("server.sqlite"),
            [key]: value,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Server failed to start");
      expect(result.stdout + result.stderr).not.toContain("Server started");
    });

test("production startup fails when the web build is missing", async ({
  playwright: _playwright,
}, testInfo) => {
  const result = spawnSync(
    "bun",
    [
      "--preload",
      join(repository, "tests/e2e/support/process-coverage.ts"),
      join(repository, "apps/server/src/main.ts"),
    ],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        LUMEN_WEB_APP: "required",
        LUMEN_WEB_ROOT: testInfo.outputPath("missing-web"),
        LUMEN_DATABASE_PATH: testInfo.outputPath("server.sqlite"),
        LUMEN_DATA_DIR: testInfo.outputPath("data"),
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("Server failed to start");
});

test("login and general request limits are separate; forwarded addresses cannot evade the peer budget", async ({
  server,
  admin,
}) => {
  await server.stop();
  await server.start({ LUMEN_MAX_REQUESTS_PER_MINUTE: "3", LUMEN_LOGIN_ATTEMPTS_PER_MINUTE: "2" });
  for (let index = 0; index < 4; index++) await server.request("/web/");
  const login = (address: string) =>
    server.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify({
        username: "admin",
        password,
        deviceId: crypto.randomUUID(),
        deviceName: "Limit test",
        platform: "desktop",
        platformDeviceId: null,
      }),
    });
  expect((await login("192.0.2.1")).status).toBe(200);
  expect((await login("192.0.2.2")).status).toBe(200);
  expect((await login("192.0.2.3")).status).toBe(429);
  const headers = { authorization: `Bearer ${admin.accessToken}` };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => server.request("/api/v1/libraries", { headers })),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
});

test("body size and malformed requests fail without leaking credentials, SQL or filesystem paths", async ({
  server,
  admin,
}) => {
  await server.stop();
  await server.start({ LUMEN_MAX_REQUEST_BODY_BYTES: "1024" });
  const headers = {
    authorization: `Bearer ${admin.accessToken}`,
    "content-type": "application/json",
  };
  const oversized = await server.request("/api/v1/libraries", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "x".repeat(2000) }),
  });
  expect(oversized.status).toBe(413);
  const malformed = await server.request("/api/v1/libraries", {
    method: "POST",
    headers,
    body: "{broken",
  });
  expect(malformed.status).toBe(400);
  for (const response of [oversized, malformed]) {
    const text = await response.text();
    expect(text).not.toContain(server.root);
    expect(text).not.toContain("INSERT");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  }
  await server.stop();
  const logs = server.log.join("");
  expect(logs).not.toContain(password);
  expect(logs).not.toContain(admin.accessToken);
  expect(logs).not.toContain("{broken");
  expect(logs).not.toContain("x".repeat(2000));
});

test("migration CLI creates a usable database and emits bounded text logs on success and failure", async ({
  server,
}) => {
  await server.stop();
  const run = (path: string) =>
    spawnSync(
      "bun",
      [
        "--preload",
        join(repository, "tests/e2e/support/process-coverage.ts"),
        join(repository, "apps/server/src/database/migrate.ts"),
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, LUMEN_DATABASE_PATH: path, LUMEN_LOG_FORMAT: "text" },
      },
    );
  const success = run(server.databasePath);
  expect(success.status, success.stderr).toBe(0);
  expect(success.stdout).toContain("migration");
  const failure = run(server.root);
  expect(failure.status).toBe(1);
  expect(failure.stdout + failure.stderr).not.toContain(server.root);
  await server.start({ LUMEN_LOG_FORMAT: "text" });
  await server.register();
  expect(await server.api("/auth/setup")).toEqual({ setupRequired: false });
  await server.stop();
  const text = server.log.filter((line) => !line.startsWith("{")).join("");
  expect(text).toContain("Stopping Lumen server");
  expect(text).not.toContain("correct horse battery staple");
});
