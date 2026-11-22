import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { openSettings, settingsValue, signIn } from "./support/browser";
import { connectDesktop, expect, test } from "./support/desktop";
import { repository, serverVersion } from "./support/server";

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
        current
          .getByRole("navigation", { name: "Primary" })
          .getByRole("link", { name: "movies", exact: true }),
      ).toBeVisible();
      await expect(current.locator(".main-content").first()).toBeVisible();
    }
    for (const region of [".nav", ".main-content"]) {
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
  // Settings is the same dialog in both, apart from what only a device has.
  const browserSettings = await openSettings(page);
  const desktopSettings = await openSettings(desktop.page);
  for (const settings of [browserSettings, desktopSettings])
    await expect(settings.getByText("Preferred audio", { exact: true })).toBeVisible();
  const settingsText = (settings: Locator) => settings.locator(".settings-dialog-body").innerText();
  expect(await settingsText(desktopSettings)).toBe(await settingsText(browserSettings));
  const categories = (settings: Locator) =>
    settings.getByRole("navigation", { name: "Settings" }).getByRole("button");
  await expect(categories(browserSettings)).toHaveText([
    "Playback",
    "About",
    "General",
    "Transcoding",
  ]);
  await expect(categories(desktopSettings)).toHaveText([
    "Playback",
    "Downloads",
    "Routes",
    "About",
    "General",
    "Transcoding",
  ]);
  // Each reports its own version beside the server's; only the desktop plays in MPV.
  for (const settings of [browserSettings, desktopSettings]) {
    await categories(settings).getByText("About", { exact: true }).click();
    await expect(settingsValue(settings, "Server")).toHaveText(serverVersion);
  }
  await expect(settingsValue(browserSettings, "App")).toHaveText(serverVersion);
  await expect(browserSettings.getByText("MPV", { exact: true })).toHaveCount(0);
  await expect(settingsValue(desktopSettings, "App")).toHaveText(
    await desktop.app.evaluate(({ app }) => app.getVersion()),
  );
  // Only a build that bundled MPV recorded its version; a development checkout may not have.
  const mpvVersion = await readFile(
    join(repository, "apps/desktop/resources/native/mpv-manifest.json"),
    "utf8",
  ).then(
    (text) => (JSON.parse(text) as { mpvVersion: string }).mpvVersion,
    () => "Unknown",
  );
  await expect(settingsValue(desktopSettings, "MPV")).toHaveText(mpvVersion);
  for (const settings of [browserSettings, desktopSettings])
    await categories(settings).getByText("General", { exact: true }).click();
  await expect(desktopSettings.getByRole("button", { name: "Switch server…" })).toBeVisible();
  await expect(browserSettings.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
  for (const current of [page, desktop.page]) {
    await current.keyboard.press("Escape");
    await expect(current.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  }
  for (const current of [page, desktop.page]) {
    await current.locator(".account-trigger").click();
    await expect(current.getByRole("menuitem", { name: /Sign out/ })).toBeVisible();
  }
  await expect(desktop.page.getByRole("menuitem", { name: "Add server…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add server…" })).toHaveCount(0);
});
