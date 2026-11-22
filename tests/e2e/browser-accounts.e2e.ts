import { openSettings, signIn } from "./support/browser";
import { latch } from "./support/proxy";
import { expect, password, test } from "./support/server";

test("account changes discard late search results and remove previously cached catalog data without reloading", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Private.mp4"]);
  await server.api("/users", {
    token: admin.accessToken,
    body: { username: "visitor", displayName: "Visitor", password },
  });
  await signIn(page, server);
  const documentStarted = await page.evaluate(() => performance.timeOrigin);
  await expect(page.getByRole("link", { name: "movies", exact: true })).toBeVisible();
  const signOut = async () => {
    await page.locator(".account-trigger").click();
    await page.getByRole("menuitem", { name: /Sign out/ }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByLabel("Username")).toBeVisible();
  };
  const login = async (username: string) => {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  };
  const held = latch();
  const captured = latch();
  const delivered = latch();
  await page.route(
    "**/api/v1/search?**",
    async (route) => {
      const response = await route.fetch();
      expect(await response.json()).toMatchObject({
        items: [expect.objectContaining({ title: "Private" })],
      });
      captured.release();
      await held.promise;
      await route.fulfill({ response }).catch(() => undefined);
      delivered.release();
    },
    { times: 1 },
  );
  const catalogHeld = latch();
  const catalogCaptured = latch();
  try {
    await page.getByRole("link", { name: /^Search/ }).click();
    await page.getByRole("textbox", { name: "Search your libraries" }).fill("Private");
    await captured.promise;
    await signOut();
    await login("visitor");
    held.release();
    await delivered.promise;
    await expect(page.getByRole("link", { name: "movies", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Play Private", exact: true })).toHaveCount(0);
    await server.api(`/libraries/${library.id}`, {
      token: admin.accessToken,
      method: "PATCH",
      body: { name: "Renamed catalog" },
    });
    await signOut();
    await page.route(
      "**/api/v1/libraries",
      async (route) => {
        const response = await route.fetch();
        catalogCaptured.release();
        await catalogHeld.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await login("admin");
    await catalogCaptured.promise;
    await expect(page.getByRole("link", { name: "movies", exact: true })).toHaveCount(0);
    catalogHeld.release();
    await expect(page.getByRole("link", { name: "Renamed catalog", exact: true })).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStarted);
  } finally {
    held.release();
    catalogHeld.release();
  }
});

test("a late unauthorized response and suspended tab cannot erase a newer browser login", async ({
  server,
  admin,
  context,
  page,
}) => {
  await signIn(page, server);
  const first = (await context.cookies()).find((cookie) => cookie.name === "lumen_session")?.value;
  await server.request("/api/v1/auth/browser/logout", {
    method: "POST",
    headers: {
      cookie: `lumen_session=${first}`,
      origin: new URL(server.origin).origin,
      "x-lumen-csrf": "1",
      "content-type": "application/json",
    },
    body: "{}",
  });
  const held = latch();
  const captured = latch();
  await page.route(
    "**/api/v1/auth/browser/session",
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(401);
      captured.release();
      await held.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    const revalidation = page.evaluate(() =>
      fetch("/api/v1/auth/browser/session").then((response) => response.status),
    );
    await captured.promise;
    const other = await context.newPage();
    await signIn(other, server);
    const current = (await context.cookies()).find(
      (cookie) => cookie.name === "lumen_session",
    )?.value;
    expect(current).not.toBe(first);
    held.release();
    expect(await revalidation).toBe(401);
    expect((await context.cookies()).find((cookie) => cookie.name === "lumen_session")?.value).toBe(
      current,
    );
    await page.unroute("**/api/v1/auth/browser/session");
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await server.api("/users", {
      token: admin.accessToken,
      body: { username: "visitor", displayName: "Visitor", password },
    });
    await other.locator(".account-trigger").click();
    await other.getByRole("menuitem", { name: /Sign out/ }).click();
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await signIn(other, server, "visitor");
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Administration", exact: true })).toHaveCount(0);
    // Server settings are for administrators only.
    const settings = await openSettings(page);
    await expect(settings.getByText("Server", { exact: true })).toHaveCount(0);
    await expect(
      settings.getByRole("navigation", { name: "Settings" }).getByRole("button"),
    ).toHaveText(["Playback", "About"]);
  } finally {
    held.release();
  }
});

test("cancelling startup reconnection in the browser aborts the stalled check and allows retrying", async ({
  server,
  admin: _admin,
  page,
}) => {
  await signIn(page, server);
  const held = latch();
  const captured = latch();
  let calls = 0;
  await page.route("**/api/v1/auth/browser/session", async (route) => {
    calls += 1;
    // The first check runs while loading accounts; the second runs during startup activation.
    if (calls === 2) {
      captured.release();
      await held.promise;
      await route.continue().catch(() => undefined);
      return;
    }
    await route.continue();
  });
  try {
    await page.reload();
    await captured.promise;
    await expect(page.getByRole("heading", { name: "Reconnecting…" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose a server" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add server" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    held.release();
    await page.unroute("**/api/v1/auth/browser/session");
    await page.locator(".server-row-open").first().click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  } finally {
    held.release();
  }
});
