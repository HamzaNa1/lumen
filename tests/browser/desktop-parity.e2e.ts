import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Renders the desktop renderer build and the web build side by side — same server, same data,
// same account, same viewport, same browser engine — and requires the shared pages to come out
// pixel for pixel alike. The desktop renderer runs here in a browser behind a stand-in for its
// Electron bridge, so this proves the two builds draw the same pages; it does not exercise
// Electron's window chrome or the native player.

const repository = fileURLToPath(new URL("../../", import.meta.url));
const desktopRenderer = join(repository, "apps/desktop/out/renderer");
const DESKTOP_BASE = "/desktop-renderer";
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

test.skip(({ browserName }) => browserName !== "chromium", "One engine is enough to compare builds");
test.skip(!existsSync(join(desktopRenderer, "index.html")), "Build the desktop renderer first");

let shim = "";
test.beforeAll(() => {
  const output = join(mkdtempSync(join(tmpdir(), "lumen-parity-")), "bridge.js");
  execFileSync(
    "bun",
    ["build", "tests/browser/desktopBridgeShim.ts", "--outfile", output, "--target", "browser"],
    { cwd: repository, stdio: "pipe" },
  );
  shim = readFileSync(output, "utf8");
});

const signIn = async (context: BrowserContext, baseURL: string): Promise<void> => {
  const response = await context.request.post("/api/v1/auth/browser/login", {
    headers: { origin: baseURL, "x-lumen-csrf": "1" },
    data: {
      username: "admin",
      password: "correct horse battery staple",
      deviceId: crypto.randomUUID(),
      deviceName: "Parity test",
    },
  });
  expect(response.status()).toBe(200);
};

/** The desktop renderer's files, served from the test server's origin so it can reach the API. */
const openDesktop = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await page.route(`**${DESKTOP_BASE}/**`, async (route) => {
    const file = join(desktopRenderer, new URL(route.request().url()).pathname.slice(DESKTOP_BASE.length));
    await route.fulfill({
      body: readFileSync(file),
      contentType: contentTypes[extname(file)] ?? "application/octet-stream",
    });
  });
  await page.addInitScript(shim);
  return page;
};

const settled = async (page: Page): Promise<void> => {
  await expect(page.locator(".main-content")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".spinner, [class*='skeleton']")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  // Nothing should still be easing into place when the picture is taken.
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
};

test("the desktop and web builds draw the shared pages identically", async ({
  context,
  baseURL,
}, testInfo) => {
  await signIn(context, baseURL ?? "");
  const libraries = (await (await context.request.get("/api/v1/libraries")).json()) as { id: string }[];
  const libraryId = libraries[0]?.id ?? "";
  const items = (await (
    await context.request.get(`/api/v1/items?libraryId=${libraryId}&limit=50`)
  ).json()) as { items: { id: string; title: string }[] };
  const film = items.items.find((item) => item.title === "Film")?.id ?? "";
  expect(film).not.toBe("");

  const routes = [
    ["home", "/"],
    ["library index", "/library"],
    ["library", `/library/${libraryId}`],
    ["movie details", `/item/${film}`],
    ["search", "/search?q=Film"],
    ["settings", "/settings"],
    ["administration", "/admin"],
    ["users", "/admin/users"],
    ["job log", "/admin/jobs"],
  ] as const;

  const web = await context.newPage();
  const desktop = await openDesktop(context);
  for (const [name, route] of routes) {
    await web.goto(`/web${route}`);
    await desktop.goto(`${DESKTOP_BASE}/index.html#${route}`);
    // Changing only the hash navigates inside the running page. Reload so that both builds
    // draw the route from a fresh document, as the web build just did.
    await desktop.reload();
    await settled(web);
    await settled(desktop);
    // Both routers must have ended up in the same place, including after any redirect.
    await expect
      .poll(() => desktop.evaluate(() => window.location.hash.slice(1)))
      .toBe(await web.evaluate(() => (location.pathname + location.search).replace(/^\/web/u, "")));

    // Navigation is shared; the account menu beneath it differs by design and is left out.
    for (const region of [".nav", ".main-content"]) {
      // Settings names each platform's player, sign-in storage and server actions.
      if (name === "settings" && region === ".main-content") continue;
      // Some content arrives without a loading indicator to wait on (a library's folders, for
      // one), so the two pages may briefly be at different stages. A real difference between
      // the builds never goes away, so keep comparing until they agree or time runs out.
      let shots: readonly [Buffer, Buffer] = [Buffer.alloc(0), Buffer.alloc(0)];
      const matches = async (): Promise<boolean> => {
        shots = await Promise.all([
          web.locator(region).screenshot(),
          desktop.locator(region).screenshot(),
        ]);
        return shots[0].equals(shots[1]);
      };
      try {
        await expect
          .poll(matches, {
            message: `${name}: ${region} differs between the builds`,
            timeout: 10_000,
          })
          .toBe(true);
      } catch (cause) {
        // Keep both pictures so a difference can be looked at, not just reported.
        for (const [build, shot] of [["web", shots[0]], ["desktop", shots[1]]] as const) {
          const path = testInfo.outputPath(`${name}-${region.slice(1)}-${build}.png`);
          writeFileSync(path, shot);
          await testInfo.attach(`${name} ${region} ${build}`, { path, contentType: "image/png" });
        }
        throw cause;
      }
    }
  }

  // Settings is the one page meant to differ, and only in what each platform reports.
  await web.goto("/web/settings");
  await desktop.goto(`${DESKTOP_BASE}/index.html#/settings`);
  await expect(web.getByText("Browser cookie")).toBeVisible();
  await expect(desktop.getByText("MPV", { exact: true })).toBeVisible();
  await expect(desktop.getByRole("button", { name: "Switch server…" })).toBeVisible();
  await expect(web.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
});
