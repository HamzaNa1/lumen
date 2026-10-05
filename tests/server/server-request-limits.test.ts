import { describe, expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { unauthorized } from "../../apps/server/src/core/Errors";
import { LimitExceeded, RequestLimiter } from "../../apps/server/src/core/Limits";
import { createLogger } from "../../apps/server/src/core/Logger";
import { makeHttpHandler, type HttpServices } from "../../apps/server/src/http/HttpApp";

const limiter = (maxRequests = 2, loginRequests = 1) =>
  new RequestLimiter({ maxRequests, loginRequests, maxActive: 1 });
const check = (limits: RequestLimiter, nowMs: number, kind: "request" | "login" = "request") =>
  Effect.runPromise(limits.check("client", nowMs, kind));

describe("request limits", () => {
  test("general requests and logins have independent budgets and windows", async () => {
    const limits = limiter();
    await check(limits, 0);
    await check(limits, 1);
    await check(limits, 30_000, "login");
    await expect(check(limits, 30_001)).rejects.toMatchObject({ retryAfterSeconds: 30 });
    await expect(check(limits, 30_001, "login")).rejects.toMatchObject({ retryAfterSeconds: 60 });
    // Sweeping the expired general window must retain the login window.
    limits.sweep(60_000);
    await check(limits, 60_000);
    await expect(check(limits, 60_000, "login")).rejects.toMatchObject({ retryAfterSeconds: 30 });
    await check(limits, 90_000, "login");
    await check(limits, 90_001);
    await expect(check(limits, 90_002)).rejects.toBeInstanceOf(LimitExceeded);
  });

  test("logins do not spend the general request allowance", async () => {
    const limits = limiter(1, 2);
    await check(limits, 0, "login");
    await check(limits, 1, "login");
    await check(limits, 2);
    await expect(check(limits, 3)).rejects.toBeInstanceOf(LimitExceeded);
    await expect(check(limits, 3, "login")).rejects.toBeInstanceOf(LimitExceeded);
  });

  test("window resets and sweeps preserve the shared concurrency cap and release the original request", async () => {
    const limits = limiter();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    await check(limits, 0);
    const pending = Effect.runPromise(limits.run("client", Effect.promise(async () => {
      enter();
      await held;
    })));
    try {
      await entered;
      limits.sweep(60_000);
      await check(limits, 60_000);
      await check(limits, 60_000, "login");
      for (const kind of ["request", "login"] as const) {
        await expect(Effect.runPromise(limits.run("client", Effect.succeed(kind))))
          .rejects.toMatchObject({ retryAfterSeconds: 1 });
      }
      // Another client keeps its own concurrency allowance.
      expect(await Effect.runPromise(limits.run("other", Effect.succeed("ok")))).toBe("ok");
    } finally {
      release();
      await pending;
    }
    expect(await Effect.runPromise(limits.run("client", Effect.succeed("released")))).toBe("released");
    await expect(Effect.runPromise(limits.run("client", Effect.fail(new Error("failed")))))
      .rejects.toThrow("failed");
    limits.sweep(120_000);
    expect(await Effect.runPromise(limits.run("client", Effect.succeed("released after failure"))))
      .toBe("released after failure");
  });
});

const handler = () => {
  let loginCalls = 0;
  const fetch = makeHttpHandler({
    auth: {
      setupRequired: () => Effect.succeed(false),
      login: () => {
        loginCalls += 1;
        return Effect.succeed({ accessToken: "test-session" });
      },
      authenticate: () => Effect.fail(unauthorized()),
    },
    identity: { installationId: crypto.randomUUID() },
    serverName: { name: () => Effect.succeed("Lumen") },
  } as unknown as HttpServices, decodeConfig({}), createLogger({
    level: "error",
    format: "json",
    destination: { write: () => undefined },
  }));
  const login = () => fetch(new Request("http://lumen.test/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin", password: "password", deviceId: crypto.randomUUID(),
      deviceName: "Test", platform: "desktop", platformDeviceId: null,
    }),
  }));
  return { fetch, login, loginCalls: () => loginCalls };
};

describe("HTTP authentication rate limits", () => {
  test("health, discovery and artwork requests do not consume the first login", async () => {
    const { fetch, login, loginCalls } = handler();
    for (let index = 0; index < 10; index += 1)
      expect((await fetch(new Request("http://lumen.test/health/live"))).status).toBe(200);
    expect((await fetch(new Request("http://lumen.test/api/v1/server"))).status).toBe(200);
    expect((await fetch(new Request("http://lumen.test/api/v1/auth/setup"))).status).toBe(200);
    expect((await fetch(new Request("http://lumen.test/api/v1/artwork/test"))).status).toBe(401);
    expect((await login()).status).toBe(200);
    expect(loginCalls()).toBe(1);
  });

  test("all token and browser auth mutations share the stricter login allowance", async () => {
    const { fetch, login, loginCalls } = handler();
    for (let index = 0; index < 10; index += 1) expect((await login()).status).toBe(200);
    for (const path of ["login", "register", "migrate-session", "browser/login", "browser/register"]) {
      const response = await fetch(new Request(`http://lumen.test/api/v1/auth/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      expect(response.status).toBe(429);
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(loginCalls()).toBe(10);
    expect((await fetch(new Request("http://lumen.test/health/live"))).status).toBe(200);
  });
});
