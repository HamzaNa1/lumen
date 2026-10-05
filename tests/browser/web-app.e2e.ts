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

test("every route survives direct navigation and refresh", async ({ page }) => {
  await signIn(page);
  for (const path of ["/web/search", "/web/settings", "/web/admin", "/web/admin/users", "/web/admin/jobs", "/web/library"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".page").first()).toBeVisible();
  }
  await page.goto("/web/settings");
  await expect(page.getByText("Browser cookie")).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
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

test("a file the browser cannot play says so instead of loading forever", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Clip" }).first().click({ force: true });
  await expect(page.getByText("Playback failed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/can’t play this file’s format|could not be played/u)).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("supported media plays under the shared controls", async ({ page, browserName }) => {
  // Playwright's WebKit and Firefox builds ship without the proprietary H.264/AAC decoders.
  test.skip(browserName !== "chromium", "The fixture is H.264/AAC, which this browser build lacks");
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Film" }).first().click({ force: true });
  await expect(page).toHaveURL(/\/web\/player$/u);
  const player = page.getByRole("region", { name: "Media player" });
  await expect(player).toBeVisible();
  // Headless browsers refuse unprompted playback with sound; the player then asks for a click.
  const start = page.getByRole("button", { name: "Play", exact: true });
  if (await start.isVisible().catch(() => false)) await start.click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0))
    .toBeGreaterThan(0.2);
  // The grant that authorises the stream stays in the element, out of the address bar and storage.
  const exposure = await page.evaluate(() => ({
    href: location.href,
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    source: document.querySelector("video")?.src ?? "",
  }));
  expect(exposure.source).toContain("grant=");
  expect(exposure.href).not.toContain("grant");
  expect(exposure.storage).not.toContain("grant");

  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.paused)).toBe(true);
  await page.mouse.move(320, 320);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector("video"))).toBeNull();
});
