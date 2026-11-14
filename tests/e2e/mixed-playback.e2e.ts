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
