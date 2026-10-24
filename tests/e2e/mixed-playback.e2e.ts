import { pause, playing, signIn } from "./support/browser";
import { connectDesktop, expect, test } from "./support/desktop";

test("real browser and Electron players join, buffer, pause, seek and leave a protected group together", async ({
  server,
  admin,
  page,
  desktop,
}) => {
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await signIn(page, server);
  await connectDesktop(desktop.page, server);
  await page.locator(".watch-group-trigger").click();
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Together");
  await page.getByLabel("Password", { exact: true }).fill("secret");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page.locator(".watch-group-trigger.is-active")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      desktop.page.evaluate(async () =>
        (await window.lumen.watch.action({ type: "list" })).groups.map((group) => group.name),
      ),
    )
    .toContain("Together");
  const groups = await desktop.page.evaluate(
    async () => (await window.lumen.watch.action({ type: "list" })).groups,
  );
  const id = groups.find((group) => group.name === "Together")?.id ?? "";
  expect(id).toBeTruthy();
  await desktop.page.evaluate(
    (groupId) => window.lumen.watch.action({ type: "join", groupId, password: "secret" }),
    id,
  );
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await playing(page);
  await expect
    .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: false });
  const positions = await Promise.all([
    page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime),
    desktop.page.evaluate(async () => (await window.lumen.player.state())?.positionSeconds ?? -10),
  ]);
  expect(Math.abs(positions[0] - positions[1])).toBeLessThan(1.5);
  await pause(page);
  await expect
    .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: true });
  await desktop.page.evaluate(async () => {
    const group = (await window.lumen.watch.state()).group;
    if (!group?.playback) throw new Error("Missing playback");
    await window.lumen.watch.action({
      type: "seek",
      itemId: group.playback.itemId,
      positionSeconds: 7,
    });
  });
  await expect
    .poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(7, 0);
  await expect
    .poll(() =>
      desktop.page.evaluate(async () => (await window.lumen.player.state())?.positionSeconds),
    )
    .toBeCloseTo(7, 0);
  await desktop.page.evaluate(() => window.lumen.watch.action({ type: "leave" }));
  expect(
    await desktop.page.evaluate(async () => (await window.lumen.watch.state()).group),
  ).toBeNull();
  await page.mouse.move(320, 320);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await desktop.page.evaluate(() => window.lumen.player.stop());
});

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
      await expect(current.getByRole("navigation", { name: "Primary" })).toBeVisible();
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
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              text: (element as HTMLElement).innerText,
              width: Math.round(rect.width),
              font: style.font,
              color: style.color,
              background: style.backgroundColor,
            };
          });
      await expect.poll(() => snapshot(desktop.page)).toEqual(await snapshot(page));
    }
  }
  await page.goto(`${server.origin}web/settings`);
  await desktop.page.evaluate(() => {
    location.hash = "/settings";
  });
  await expect(desktop.page.getByRole("button", { name: "Switch server…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
  for (const current of [page, desktop.page]) {
    await current.locator(".account-trigger").click();
    await expect(current.getByRole("menuitem", { name: /Sign out/ })).toBeVisible();
  }
  await expect(desktop.page.getByRole("menuitem", { name: "Add server…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add server…" })).toHaveCount(0);
});
