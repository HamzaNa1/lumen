import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const PASSWORD = "correct horse battery staple";

const signIn = async (page: Page): Promise<void> => {
  await page.goto("/web/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
};

const sessionCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === "lumen_session");

test("signs in with a cookie scripts cannot read, and a reload restores the session", async ({
  page,
  context,
}) => {
  await page.goto("/web");
  await expect(page).toHaveURL(/\/web\/$/u);
  // The server address is fixed to where the app was loaded from.
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Server address")).toHaveCount(0);
  await signIn(page);

  const cookie = await sessionCookie(context);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
  const visible = await page.evaluate(() => ({
    cookie: document.cookie,
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
  }));
  expect(visible.cookie).not.toContain("lumen_session");
  expect(visible.storage).not.toContain(cookie?.value ?? "missing");

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByText("Movies").first()).toBeVisible();
});

test("the page names its own icon, so the browser never asks the API for one", async ({ page }) => {
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 401 && !new URL(response.url()).pathname.startsWith("/api/"))
      refused.push(response.url());
  });
  await page.goto("/web/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toMatch(/^\/web\/assets\/.+\.svg$/u);
  const icon = await page.request.get(href ?? "");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/svg+xml");
  expect(refused).toEqual([]);
});

test("every route survives direct navigation and refresh", async ({ page }) => {
  await signIn(page);
  for (const path of [
    "/web/search",
    "/web/settings",
    "/web/admin",
    "/web/admin/users",
    "/web/admin/jobs",
    "/web/library",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".page").first()).toBeVisible();
  }
  await page.goto("/web/settings");
  await expect(page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
});

test("an administrator renames the server from settings", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/web/settings");
  const server = page.getByRole("region", { name: "Server" }).locator(".settings-row").first();
  await expect(server).toContainText("Lumen Server");
  const rename = async (name: string): Promise<void> => {
    await server.getByRole("button", { name: "Rename…" }).click();
    await page.getByLabel("Server name").fill(name);
    await testInfo.attach("rename server", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(server).toContainText(name);
  };
  await rename("Living room");
  // The server keeps the name, so a fresh page load reads it back.
  await page.reload();
  await expect(server).toContainText("Living room");
  await rename("Lumen Server");
});

test("signing out in one tab signs out the others", async ({ page, context }) => {
  await signIn(page);
  const other = await context.newPage();
  await other.goto("/web/settings");
  await expect(other.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Sign out/u }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await sessionCookie(context)).toBeUndefined();
});

test("a session revoked on the server returns the app to sign-in", async ({ page, context }) => {
  await signIn(page);
  const cookie = await sessionCookie(context);
  const sessionId = cookie?.value.split(".")[0];
  const revoked = await page.evaluate(
    async (id) =>
      (
        await fetch(`/api/v1/auth/sessions/${id}`, {
          method: "DELETE",
          headers: { "x-lumen-csrf": "1" },
        })
      ).status,
    sessionId,
  );
  expect(revoked).toBe(200);
  // The next request the app makes is refused. That may be one already under way, so the
  // sidebar can be gone at any moment; go straight to a page rather than clicking through it.
  await page.goto("/web/admin/users");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("an old unauthorized request cannot erase a newer sign-in's cookie", async ({
  page,
  context,
}) => {
  // Keep the actual browser cookie jar, but leave the app runtime out of the race.
  await page.goto("/health/live");
  const login = () =>
    page.evaluate(
      async (password) =>
        (
          await fetch("/api/v1/auth/browser/login", {
            method: "POST",
            headers: { "content-type": "application/json", "x-lumen-csrf": "1" },
            body: JSON.stringify({
              username: "admin",
              password,
              deviceId: crypto.randomUUID(),
              deviceName: "Cookie race",
            }),
          })
        ).status,
      PASSWORD,
    );
  expect(await login()).toBe(200);
  const oldCookie = await sessionCookie(context);
  const oldSessionId = oldCookie?.value.split(".")[0];
  expect(
    await page.evaluate(
      async (sessionId) =>
        (
          await fetch(`/api/v1/auth/sessions/${sessionId}`, {
            method: "DELETE",
            headers: { "x-lumen-csrf": "1" },
          })
        ).status,
      oldSessionId,
    ),
  ).toBe(200);
  let arrived!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(401);
    arrived();
    await gate;
    // Deliver the real server's old response only after the new cookie is installed.
    await route.fulfill({ response });
  });
  const oldRequest = page.evaluate(async () => (await fetch("/api/v1/auth/me")).status);
  try {
    await requested;
    expect(await login()).toBe(200);
    const newCookie = await sessionCookie(context);
    expect(newCookie?.value).not.toBe(oldCookie?.value);
    release();
    expect(await oldRequest).toBe(401);
    expect((await sessionCookie(context))?.value).toBe(newCookie?.value);
    expect(
      await page.evaluate(async () => (await fetch("/api/v1/auth/browser/session")).status),
    ).toBe(200);
  } finally {
    release();
    await oldRequest;
  }
});

test("a file the browser cannot play says so instead of loading forever", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Clip" }).first().click({ force: true });
  await expect(page.getByText("Playback failed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/can’t play this file’s format|could not be played/u)).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

/** Starts the fixture film from a page that lists it, and waits until it is really playing. */
const playFilm = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Play Film" }).first().click({ force: true });
  await expect(page).toHaveURL(/\/web\/player$/u);
  await expect(page.getByRole("region", { name: "Media player" })).toBeVisible();
  // Headless browsers refuse unprompted playback with sound; the player then asks for a click.
  const start = page.getByRole("button", { name: "Play", exact: true });
  if (await start.isVisible().catch(() => false)) await start.click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0))
    .toBeGreaterThan(0.2);
};

test("supported media plays under the shared controls", async ({ page, browserName }, testInfo) => {
  // Playwright's WebKit and Firefox builds ship without the proprietary H.264/AAC decoders.
  test.skip(browserName !== "chromium", "The fixture is H.264/AAC, which this browser build lacks");
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  // The grant that authorises the stream stays in the element, out of the address bar and storage.
  const exposure = await page.evaluate(() => ({
    href: location.href,
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    source: document.querySelector("video")?.src ?? "",
  }));
  expect(exposure.source).toContain("grant=");
  expect(exposure.href).not.toContain("grant");
  expect(exposure.storage).not.toContain("grant");

  const isFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  await page.keyboard.press("f");
  await expect.poll(isFullscreen).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await page.keyboard.press("f");
  await expect.poll(isFullscreen).toBe(false);
  await expect(page.getByRole("button", { name: "Enter fullscreen", exact: true })).toBeVisible();

  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.paused)).toBe(true);
  await expect(page.getByText(/^Ends at \d{1,2}:\d{2}/u)).toBeVisible();
  await testInfo.attach("player ends at", { body: await page.screenshot(), contentType: "image/png" });
  await page.mouse.move(320, 320);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector("video"))).toBeNull();
});

test("clicking the video toggles playback without taking focus", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "The fixture is H.264/AAC, which this browser build lacks");
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  const paused = () => page.evaluate(() => document.querySelector("video")?.paused);

  await page.mouse.move(700, 400);
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await page.mouse.click(700, 400);
  await expect.poll(paused).toBe(true);
  await expect(page.getByRole("button", { name: "Resume playback" })).toBeVisible();
  // A key press is what turns a pointer-given focus into a visible focus ring.
  await page.keyboard.press("Space");
  await expect.poll(paused).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  await testInfo.attach("player after click", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("the player controls hide once the viewer is done with the settings", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The fixture is H.264/AAC, which this browser build lacks");
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  const player = page.getByRole("region", { name: "Media player" });
  const settings = page.getByRole("button", { name: "Playback settings", exact: true });
  const panel = page.locator(".media-player-settings-panel");

  // Closed again from its own button, which the click leaves focused.
  await settings.click();
  await expect(panel).toBeVisible();
  await settings.click();
  await page.mouse.move(300, 300);
  await expect(player).not.toHaveClass(/controls-visible/u, { timeout: 8_000 });

  // Left open while the pointer rests on the video.
  await page.mouse.move(320, 320);
  await settings.click();
  await expect(panel).toBeVisible();
  await page.mouse.move(300, 300);
  await expect(player).not.toHaveClass(/controls-visible/u, { timeout: 8_000 });
  await page.mouse.move(320, 320);
  await expect(player).toHaveClass(/controls-visible/u);
  await expect(panel).toBeHidden();
});

test("a watch group's film starts playing in the browser", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The fixture is H.264/AAC, which this browser build lacks");
  await signIn(page);
  await page.locator(".watch-group-trigger").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("Movie night");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.locator(".watch-group-trigger.is-active")).toBeVisible();
  await page.keyboard.press("Escape");

  // Membership lives in this page, so reach the library without loading another.
  await page.getByRole("link", { name: "Movies", exact: true }).click();
  await playFilm(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.paused)).toBe(false);

  // Each member is shown how much of the film their player holds.
  await page.mouse.move(400, 400);
  await page.getByRole("button", { name: "Movie night, 1 person" }).click();
  await expect(page.locator(".watch-group-members .watch-group-buffer")).toContainText("buffered", {
    timeout: 10_000,
  });
});

test("older servers keep settings usable without requesting unsupported track memory endpoints", async ({ page }) => {
  const unsupportedRequests: string[] = [];
  await page.route("**/api/v1/server", async (route) => {
    const response = await route.fetch();
    const identity = await response.json();
    delete identity.capabilities.trackMemory;
    await route.fulfill({ response, json: identity });
  });
  for (const path of ["**/api/v1/me/track-preferences", "**/api/v1/playback/sessions/*/track-choice"])
    await page.route(path, async (route) => {
      unsupportedRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 404, json: { message: "Not found" } });
    });
  await signIn(page);
  await page.goto("/web/settings");
  await expect(page.getByText("This server does not support saved audio and subtitle settings.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Preferred audio language" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Preferred subtitles" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Server" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("This server does not support saved audio and subtitle settings.")).toBeVisible();
  expect(unsupportedRequests).toEqual([]);
});

test("audio and subtitle settings persist after reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/settings");
  const audio = page.getByRole("combobox", { name: "Preferred audio language" });
  const subtitles = page.getByRole("combobox", { name: "Preferred subtitles" });
  await expect(audio).toContainText("English");
  await expect(subtitles).toContainText("Off");
  await audio.click();
  await page.getByRole("option", { name: "Japanese", exact: true }).click();
  await expect(audio).toContainText("Japanese");
  await subtitles.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(subtitles).toContainText("English");
  await page.reload();
  await expect(audio).toContainText("Japanese");
  await expect(subtitles).toContainText("English");
  // Restore the shared fixture's preferences for the next browser project.
  await audio.click(); await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(audio).toContainText("English");
  await subtitles.click(); await page.getByRole("option", { name: "Off", exact: true }).click();
  await expect(subtitles).toContainText("Off");
});
