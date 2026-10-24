import { request } from "node:http";
import { expect, password, test } from "./support/server";

test("HTTP rate windows reset independently and every authentication mutation spends the login allowance", async ({
  server,
  admin: _admin,
}) => {
  await server.stop();
  await server.start({
    LUMEN_MAX_REQUESTS_PER_MINUTE: "2",
    LUMEN_LOGIN_ATTEMPTS_PER_MINUTE: "1",
    LUMEN_TRUSTED_PROXIES: "127.0.0.1",
  });
  const headers = {
    "x-forwarded-for": "192.0.2.20",
    "content-type": "application/json",
    origin: new URL(server.origin).origin,
    "x-lumen-csrf": "1",
  };
  const read = () => server.request("/health/live", { headers });
  const auth = (path = "login") =>
    server.request(`/api/v1/auth/${path}`, { method: "POST", headers, body: "{}" });
  expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(429);
  await server.advanceTime(30_000);
  expect((await auth()).status).toBe(400);
  await server.advanceTime(30_001);
  expect((await read()).status).toBe(200);
  const limited = await auth();
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(30);
  await server.advanceTime(30_001);
  const paths = ["login", "register", "migrate-session", "browser/login", "browser/register"];
  for (const first of paths) {
    await server.advanceTime(60_001);
    expect((await auth(first)).status).toBe(400);
    for (const path of paths) expect((await auth(path)).status).toBe(429);
    expect((await read()).status).toBe(200);
  }
});

for (const valid of [true, false])
  test(`a held HTTP body retains its concurrency slot across a sweep and releases it after ${valid ? "success" : "failure"}`, async ({
    server,
    admin: _admin,
  }) => {
    await server.stop();
    await server.start({ LUMEN_MAX_CONCURRENT_REQUESTS: "1", LUMEN_TRUSTED_PROXIES: "127.0.0.1" });
    const peer = { "x-forwarded-for": "192.0.2.30" };
    const body = valid
      ? JSON.stringify({
          username: "admin",
          password,
          deviceId: crypto.randomUUID(),
          deviceName: "Held",
          platform: "desktop",
          platformDeviceId: null,
        })
      : "invalid-json";
    const response = Promise.withResolvers<number>();
    const pending = request(
      new URL("/api/v1/auth/login", server.origin),
      {
        method: "POST",
        headers: {
          ...peer,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => response.resolve(incoming.statusCode ?? 0));
      },
    );
    pending.on("error", response.reject);
    try {
      pending.write(body.slice(0, 1));
      await expect
        .poll(async () => (await server.request("/health/live", { headers: peer })).status)
        .toBe(429);
      await server.advanceTime(60_001);
      for (const path of ["/health/live", "/api/v1/auth/login"]) {
        const blocked = await server.request(path, { headers: peer });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("1");
      }
      expect(
        (await server.request("/health/live", { headers: { "x-forwarded-for": "192.0.2.31" } }))
          .status,
      ).toBe(200);
      pending.end(body.slice(1));
      expect(await response.promise).toBe(valid ? 200 : 400);
      expect((await server.request("/health/live", { headers: peer })).status).toBe(200);
    } finally {
      pending.destroy();
    }
  });
