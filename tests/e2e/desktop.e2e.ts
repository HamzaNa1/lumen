import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";

test("desktop connects through real IPC, persists its account and window, and never exposes tokens to the renderer", async ({
  server,
  admin,
  desktop,
}) => {
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const { page, app, profile } = desktop;
  await connectDesktop(page, server);
  const accounts = await page.evaluate(() => window.lumen.accounts.list());
  expect(accounts.accounts).toHaveLength(1);
  expect(JSON.stringify(accounts)).not.toContain("accessToken");
  expect(accounts.activeConnectionId).toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage }))).not.toContain(
    admin.accessToken,
  );
  expect(await page.evaluate(() => window.lumen.library.list())).toHaveLength(1);
  const desktopWindow = await app.browserWindow(page);
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const { bounds, minimum } = await desktopWindow.evaluate((window) => ({
    bounds: window.getBounds(),
    minimum: window.getMinimumSize(),
  }));
  const [minWidth, minHeight] = minimum;
  const size = {
    width: bounds.width === minWidth ? Math.max(minWidth, Math.min(1100, area.width)) : minWidth,
    height:
      bounds.height === minHeight ? Math.max(minHeight, Math.min(750, area.height)) : minHeight,
  };
  expect(bounds, "The persistence test must change the window size").not.toMatchObject(size);
  await desktopWindow.evaluate((window, bounds) => window.setBounds(bounds), {
    x: area.x,
    y: area.y,
    ...size,
  });
  await expect
    .poll(() => desktopWindow.evaluate((window) => window.getBounds()))
    .toMatchObject(size);
  await expect
    .poll(async () =>
      JSON.parse(
        await readFile(join(profile, "main-window-state.json"), "utf8").catch(() => "null"),
      ),
    )
    .toMatchObject({ bounds: size });
  await app.close();
  const reopened = await launchDesktop(profile);
  try {
    const restored = await mainDesktopPage(reopened);
    await expect(restored.getByRole("navigation", { name: "Primary" })).toBeVisible();
    expect(await restored.evaluate(() => window.lumen.accounts.list())).toMatchObject({
      activeConnectionId: accounts.activeConnectionId,
    });
    const desktopWindow = await reopened.browserWindow(restored);
    expect(await desktopWindow.evaluate((window) => window.getBounds())).toMatchObject(size);
  } finally {
    await reopened.close();
  }
});

test("native media decodes, seeks, changes volume and audio, survives replacement and releases playback on stop", async ({
  server,
  admin,
  desktop,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4", "Other.mp4"]);
  const { page, app } = desktop;
  await connectDesktop(page, server);
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: false });
  const state = await page.evaluate(() => window.lumen.player.state());
  expect(state).not.toBeNull();
  const sessionId = state?.sessionId ?? "";
  await page.evaluate((sessionId) => window.lumen.player.pause(sessionId, true), sessionId);
  await page.evaluate((sessionId) => window.lumen.player.seek(sessionId, 5), sessionId);
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: true, positionSeconds: 5 });
  await page.evaluate((sessionId) => window.lumen.player.volume(sessionId, 35, false), sessionId);
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ volume: 35, muted: false });
  expect(
    await page.evaluate((sessionId) => window.lumen.player.info(sessionId), sessionId),
  ).toMatchObject({
    player: expect.stringContaining("mpv"),
    videoSize: { width: 640, height: 360 },
  });
  await page.evaluate(
    (sessionId) => window.lumen.player.audioOutput(sessionId, "stereo"),
    sessionId,
  );
  const audio = state?.streams.find((stream) => stream.kind === "audio");
  expect(audio).toBeDefined();
  await page.evaluate(
    ({ sessionId, streamId }) => window.lumen.player.selectAudio(sessionId, streamId),
    { sessionId, streamId: audio?.id ?? "" },
  );
  const other = (await server.items(admin.accessToken, library.id)).find(
    (item) => item.title === "Other",
  );
  await page.evaluate((itemId) => window.lumen.player.start(itemId), other?.id ?? "");
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ itemId: other?.id });
  await expect(
    page.evaluate((sessionId) => window.lumen.player.seek(sessionId, 2), sessionId),
  ).rejects.toThrow();
  await page.evaluate(() => window.lumen.player.stop());
  await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
  expect((await app.windows()).length).toBeGreaterThanOrEqual(1);
});
