import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "../../apps/server/src/Runtime";

const running: RunningServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const start = async (overrides: Parameters<typeof startServer>[0] = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-browser-session-"));
  directories.push(root);
  const server = await startServer({
    databasePath: join(root, "server.sqlite"),
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    loginAttemptsPerMinute: 100,
    ...overrides,
  });
  running.push(server);
  const origin = server.server.url.origin;
  /** A request as the web app would send it: same origin, with the CSRF header. */
  const browser = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie !== undefined) headers.set("cookie", init.cookie);
    if (!headers.has("origin")) headers.set("origin", origin);
    if (init.method !== undefined && init.method !== "GET" && !headers.has("x-lumen-csrf"))
      headers.set("x-lumen-csrf", "1");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(new URL(path, origin), { ...init, headers });
  };
  const account = {
    username: "owner",
    displayName: "Owner",
    password: "correct horse battery staple",
    deviceId: crypto.randomUUID(),
    deviceName: "Test browser",
  };
  const register = () =>
    browser("/api/v1/auth/browser/register", { method: "POST", body: JSON.stringify(account) });
  return { origin, browser, account, register };
};

const sessionCookie = (response: Response): string => {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("lumen_session="));
  if (cookie === undefined) throw new Error("No session cookie was set");
  return cookie;
};
const cookiePair = (response: Response): string => sessionCookie(response).split(";")[0] ?? "";

describe("browser sessions", () => {
  test("first-run setup signs in with a script-proof cookie and never reveals the token", async () => {
    const { register, browser } = await start();
    const response = await register();
    expect(response.status).toBe(201);
    const cookie = sessionCookie(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api");
    expect(cookie).not.toContain("Domain=");
    // Plain HTTP on a home network: a Secure cookie would never be sent back.
    expect(cookie).not.toContain("Secure");
    expect(cookie).toMatch(/Max-Age=86\d{4}/u);
    const text = await response.text();
    const token = cookiePair(response).slice("lumen_session=".length);
    expect(text).not.toContain(token);
    expect(text).not.toContain("accessToken");
    const body = JSON.parse(text) as { user: { username: string; role: string } };
    expect(body.user).toMatchObject({ username: "owner", role: "admin" });
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const me = await browser("/api/v1/auth/me", { cookie: cookiePair(response) });
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("private, no-store");
  });

  test("the cookie is Secure when the app is reached over HTTPS", async () => {
    const { register, origin } = await start();
    await register();
    const login = await fetch(new URL("/api/v1/auth/browser/login", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        origin: origin.replace("http:", "https:"),
        "x-lumen-csrf": "1",
      },
      body: JSON.stringify({
        username: "owner",
        password: "correct horse battery staple",
        deviceId: crypto.randomUUID(),
        deviceName: "Test browser",
      }),
    });
    expect(login.status).toBe(200);
    expect(sessionCookie(login)).toContain("Secure");
  });

  test("an explicit policy overrides the request's scheme", async () => {
    const { register } = await start({ cookieSecure: "always" });
    expect(sessionCookie(await register())).toContain("Secure");
  });

  test("a reload restores the session and renews the cookie to the session's expiry", async () => {
    const { register, browser } = await start();
    const cookie = cookiePair(await register());
    const restored = await browser("/api/v1/auth/browser/session", { cookie });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { user: { username: string }; expiresAtMs: number };
    expect(body.user.username).toBe("owner");
    const maxAge = Number(/Max-Age=(\d+)/u.exec(sessionCookie(restored))?.[1]);
    expect(Math.abs(maxAge - Math.floor((body.expiresAtMs - Date.now()) / 1000))).toBeLessThan(5);
    expect((await browser("/api/v1/auth/browser/session")).status).toBe(401);
  });

  test("sign-in, sign-out and other cookie mutations are refused without proof of origin", async () => {
    const { register, browser, account, origin } = await start();
    const cookie = cookiePair(await register());
    const login = (headers: Record<string, string>) =>
      fetch(new URL("/api/v1/auth/browser/login", origin), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(account),
      });
    expect((await login({ "x-lumen-csrf": "1" })).status).toBe(403);
    expect((await login({ origin })).status).toBe(403);
    expect((await login({ origin: "https://evil.example", "x-lumen-csrf": "1" })).status).toBe(403);
    expect((await login({ origin, "x-lumen-csrf": "1" })).status).toBe(200);

    const mutate = (headers: Record<string, string>) =>
      fetch(new URL("/api/v1/libraries", origin), {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify({ id: crypto.randomUUID(), name: "Movies", slug: "movies", kind: "movies" }),
      });
    expect((await mutate({})).status).toBe(403);
    expect((await mutate({ origin: "https://evil.example", "x-lumen-csrf": "1" })).status).toBe(403);
    expect((await mutate({ origin })).status).toBe(403);
    expect((await mutate({ origin, "x-lumen-csrf": "1" })).status).toBe(201);

    const logout = await fetch(new URL("/api/v1/auth/browser/logout", origin), {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example", "x-lumen-csrf": "1" },
      body: "{}",
    });
    expect(logout.status).toBe(403);
    expect((await browser("/api/v1/auth/browser/session", { cookie })).status).toBe(200);
  });

  test("an origin a proxy presents the app on can be allowed explicitly", async () => {
    const { register, account, origin } = await start({ allowedOrigins: ["https://media.example"] });
    await register();
    const login = await fetch(new URL("/api/v1/auth/browser/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://media.example", "x-lumen-csrf": "1" },
      body: JSON.stringify(account),
    });
    expect(login.status).toBe(200);
  });

  test("signing out revokes the session and clears the cookie", async () => {
    const { register, browser } = await start();
    const cookie = cookiePair(await register());
    const logout = await browser("/api/v1/auth/browser/logout", { method: "POST", body: "{}", cookie });
    expect(logout.status).toBe(200);
    expect(sessionCookie(logout)).toContain("Max-Age=0");
    expect((await browser("/api/v1/auth/browser/session", { cookie })).status).toBe(401);
    expect((await browser("/api/v1/auth/me", { cookie })).status).toBe(401);
  });

  test("a session revoked elsewhere stops working and its cookie is cleared", async () => {
    const { register, browser, account, origin } = await start();
    const cookie = cookiePair(await register());
    const sessionId = cookie.slice("lumen_session=".length).split(".")[0];
    const desktop = (await (
      await fetch(new URL("/api/v1/auth/login", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: account.username,
          password: account.password,
          deviceId: crypto.randomUUID(),
          deviceName: "Lumen Desktop",
          platform: "desktop",
          platformDeviceId: null,
        }),
      })
    ).json()) as { accessToken: string };
    // The desktop's bearer flow is untouched: no Origin, no CSRF header.
    const revoke = await fetch(new URL(`/api/v1/auth/sessions/${sessionId}`, origin), {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktop.accessToken}` },
    });
    expect(revoke.status).toBe(200);
    const rejected = await browser("/api/v1/auth/me", { cookie });
    expect(rejected.status).toBe(401);
    expect(sessionCookie(rejected)).toContain("Max-Age=0");
    expect((await browser("/api/v1/auth/browser/session", { cookie })).status).toBe(401);
  });

  test("an expired session is refused", async () => {
    const { register, browser } = await start();
    const cookie = cookiePair(await register());
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 24 * 60 * 60 * 1000;
    try {
      expect((await browser("/api/v1/auth/browser/session", { cookie })).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  test("authorization is still enforced for a cookie session", async () => {
    const { register, browser } = await start();
    const admin = cookiePair(await register());
    const created = await browser("/api/v1/users", {
      method: "POST",
      cookie: admin,
      body: JSON.stringify({ username: "viewer", displayName: "Viewer", password: "another long password", role: "user" }),
    });
    expect(created.status).toBe(201);
    const viewer = cookiePair(
      await browser("/api/v1/auth/browser/login", {
        method: "POST",
        body: JSON.stringify({
          username: "viewer",
          password: "another long password",
          deviceId: crypto.randomUUID(),
          deviceName: "Test browser",
        }),
      }),
    );
    expect((await browser("/api/v1/users", { cookie: viewer })).status).toBe(403);
    expect((await browser("/api/v1/admin/jobs", { cookie: viewer })).status).toBe(403);
    expect((await browser("/api/v1/libraries", { cookie: viewer })).status).toBe(200);
  });
});
