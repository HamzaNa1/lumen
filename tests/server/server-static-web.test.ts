import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../apps/server/src/core/Logger";
import { makeStaticWebHandler } from "../../apps/server/src/http/StaticWeb";
import { type RunningServer, startServer } from "../../apps/server/src/Runtime";

const directories: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const PAGE = '<!doctype html><title>Lumen</title><script type="module" src="/web/assets/index-abc123.js"></script>';

const build = async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-static-web-"));
  directories.push(root);
  const webRoot = join(root, "dist");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), PAGE);
  await writeFile(join(webRoot, "assets/index-abc123.js"), "console.log('lumen');");
  await writeFile(join(webRoot, "assets/index-abc123.css"), "body{}");
  await writeFile(join(webRoot, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(join(root, "secret.txt"), "top secret");
  await symlink(join(root, "secret.txt"), join(webRoot, "assets/leak.txt"));
  await symlink(root, join(webRoot, "outside"));
  return { root, webRoot };
};

const handler = async () => {
  const { root, webRoot } = await build();
  const handle = makeStaticWebHandler(
    { webRoot, maxRequestsPerMinute: 600, maxConcurrentRequests: 16 },
    createLogger({ level: "error", format: "json" }),
  );
  const get = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://lumen.test${path}`, init));
  return { root, webRoot, get };
};

describe("static web app", () => {
  test("/web redirects to /web/ and keeps the query", async () => {
    const { get } = await handler();
    const response = await get("/web?from=bookmark");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/web/?from=bookmark");
  });

  test.each(["/web/", "/web/library/7c1d", "/web/item/abc", "/web/admin/users", "/web/search?q=a.b"])(
    "%s serves the application page for client-side navigation",
    async (path) => {
      const { get } = await handler();
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toBe(PAGE);
      // Revalidated on every visit so an upgraded server takes effect immediately.
      expect(response.headers.get("cache-control")).toBe("no-cache");
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("connect-src 'self' ws://lumen.test;");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  test("a forged forwarded host cannot rewrite the page's policy", async () => {
    const { get } = await handler();
    const response = await get("/web/", { headers: { "x-forwarded-host": "x; script-src *" } });
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).not.toContain("script-src *");
    expect(policy).toContain("connect-src 'self' ws://lumen.test;");
  });

  test("hashed assets are served with their type and cached immutably", async () => {
    const { get } = await handler();
    const script = await get("/web/assets/index-abc123.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe("console.log('lumen');");
    const style = await get("/web/assets/index-abc123.css");
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const icon = await get("/web/favicon.svg");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  test.each([
    "/web/assets/index-old999.js",
    "/web/assets/",
    "/web/assets/missing",
    "/web/missing.js",
    "/web/library/poster.png",
  ])("a missing file at %s is a 404, never the page", async (path) => {
    const { get } = await handler();
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).not.toContain("<!doctype html>");
  });

  test.each([
    "/web/../secret.txt",
    "/web/..%2fsecret.txt",
    "/web/%2e%2e/secret.txt",
    "/web/assets/..%2f..%2fsecret.txt",
    "/web/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/web/..%5csecret.txt",
    "/web/assets/leak.txt",
    "/web/outside/secret.txt",
    "/web/%00.js",
    "/web/%E0%A4%A.js",
  ])("%s cannot reach outside the build", async (path) => {
    const { get } = await handler();
    const response = await get(path);
    expect(await response.text()).not.toContain("top secret");
    expect([404, 200]).toContain(response.status);
    if (response.status === 200)
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("HEAD and conditional requests are answered without a body", async () => {
    const { get } = await handler();
    const head = await get("/web/assets/index-abc123.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("console.log('lumen');".length));
    expect(await head.text()).toBe("");
    const etag = head.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const unchanged = await get("/web/assets/index-abc123.js", { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    const page = await get("/web/");
    const revalidated = await get("/web/", {
      headers: { "if-none-match": page.headers.get("etag") ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect((await get("/web/", { method: "HEAD" })).status).toBe(200);
  });

  test("other methods are refused", async () => {
    const { get } = await handler();
    const response = await get("/web/", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  test("loading the app does not spend the API's request allowance", async () => {
    const { webRoot, root } = await build();
    const server = await startServer({
      databasePath: join(root, "server.sqlite"),
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      webRoot,
      maxRequestsPerMinute: 3,
    });
    running.push(server);
    const origin = server.server.url.origin;
    for (let index = 0; index < 8; index += 1)
      expect((await fetch(`${origin}/web/assets/index-abc123.js`)).status).toBe(200);
    expect((await fetch(`${origin}/api/v1/server`)).status).toBe(200);
    // The static handler has its own, bounded allowance.
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) statuses.push((await fetch(`${origin}/web/`)).status);
    expect(statuses).toContain(429);
  });

  test("the app and the API never answer for each other", async () => {
    const { webRoot, root } = await build();
    await mkdir(join(webRoot, "api/v1"), { recursive: true });
    await writeFile(join(webRoot, "api/v1/server"), "shadowed");
    const server = await startServer({
      databasePath: join(root, "server.sqlite"),
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      webRoot,
    });
    running.push(server);
    const origin = server.server.url.origin;
    const api = await fetch(`${origin}/api/v1/server`);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(((await api.json()) as { apiVersion: string }).apiVersion).toMatch(/^1\./u);
    expect((await fetch(`${origin}/api/v1/nothing`)).status).toBe(401);
    expect((await fetch(`${origin}/webby`)).status).toBe(401);
    const page = await fetch(`${origin}/web/library/abc`);
    expect(await page.text()).toBe(PAGE);
    const redirect = await fetch(`${origin}/web?x=1`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
  });

  test("a production server refuses to start without the built app", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-static-web-"));
    directories.push(root);
    await expect(
      startServer(
        {
          databasePath: join(root, "server.sqlite"),
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          webRoot: join(root, "missing"),
          webApp: "required",
        },
        createLogger({ level: "error", format: "json" }),
      ),
    ).rejects.toThrow(/web app is missing.*bun run build:web/u);
  });

  test("a checkout without a build explains how to produce one", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-static-web-"));
    directories.push(root);
    const handle = makeStaticWebHandler(
      { webRoot: join(root, "missing"), maxRequestsPerMinute: 600, maxConcurrentRequests: 16 },
      createLogger({ level: "error", format: "json" }),
    );
    const response = await handle(new Request("http://lumen.test/web/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run build:web");
  });
});
