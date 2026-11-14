import { signIn } from "./support/browser";
import { connectDesktop, expect, test } from "./support/desktop";

test("real desktop and browser render shared routes, forms and menus with matching content and layout", async ({
  server,
  admin,
  page,
  desktop,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const item = (await server.items(admin.accessToken, library.id))[0];
  await page.setViewportSize({ width: 1200, height: 800 });
  const window = await desktop.app.browserWindow(desktop.page);
  await window.evaluate((window) => window.setContentSize(1200, 800));
  await signIn(page, server);
  await connectDesktop(desktop.page, server);
  for (const route of [
    "/",
    "/library",
    `/library/${library.id}`,
    `/item/${item?.id}`,
    "/search?q=Film",
    "/settings",
    "/admin",
    "/admin/users",
    "/admin/jobs",
  ]) {
    await page.goto(`${server.origin}web${route}`);
    await desktop.page.evaluate((route) => {
      location.hash = route;
    }, route);
    for (const current of [page, desktop.page]) {
      await expect(
        route === "/settings"
          ? current
              .getByRole("navigation", { name: "Settings" })
              .getByRole("link", { name: "Playback", exact: true })
          : current
              .getByRole("navigation", { name: "Primary" })
              .getByRole("link", { name: "movies", exact: true }),
      ).toBeVisible();
      await expect(current.locator(".main-content").first()).toBeVisible();
    }
    const regions =
      route === "/settings" ? [".nav", ".settings-row-text"] : [".nav", ".main-content"];
    for (const region of regions) {
      const snapshot = (current: typeof page) =>
        current
          .locator(region)
          .first()
          .evaluate((element) => {
            // What only a device that keeps media offers is compared on its own below.
            const deviceOnly = [...element.querySelectorAll<HTMLElement>("[data-device-only]")];
            for (const node of deviceOnly) node.style.display = "none";
            const text = (element as HTMLElement).innerText;
            for (const node of deviceOnly) node.style.display = "";
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              text,
              width: Math.round(rect.width),
              font: style.font,
              color: style.color,
              background: style.backgroundColor,
            };
          });
      await expect(async () => {
        const [browserSnapshot, desktopSnapshot] = await Promise.all([
          snapshot(page),
          snapshot(desktop.page),
        ]);
        expect(desktopSnapshot).toEqual(browserSnapshot);
      }).toPass({ timeout: 10000 });
    }
  }
  // Downloads exist only where media can be kept: the desktop.
  await expect(
    desktop.page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Downloads" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Downloads" }),
  ).toHaveCount(0);
  await page.goto(`${server.origin}web/settings/server`);
  await desktop.page.evaluate(() => {
    location.hash = "/settings/server";
  });
  await expect(
    desktop.page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("link", { name: "Downloads" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Downloads" }),
  ).toHaveCount(0);
  // A category this client does not have falls back to the first one.
  await page.goto(`${server.origin}web/settings/downloads`);
  await expect(page).toHaveURL(/\/web\/settings\/playback$/);
  await page.goto(`${server.origin}web/settings/server`);
  await expect(desktop.page.getByRole("button", { name: "Switch server…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
  for (const current of [page, desktop.page]) {
    await current.locator(".account-trigger").click();
    await expect(current.getByRole("menuitem", { name: /Sign out/ })).toBeVisible();
  }
  await expect(desktop.page.getByRole("menuitem", { name: "Add server…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add server…" })).toHaveCount(0);
});
