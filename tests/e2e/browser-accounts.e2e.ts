import { signIn } from "./support/browser";
import { latch } from "./support/proxy";
import { expect, password, test } from "./support/server";

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
  } finally {
    held.release();
  }
});
