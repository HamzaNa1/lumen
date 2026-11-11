import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectDesktop,
  desktopPlayerPage,
  expect,
  launchDesktop,
  mainDesktopPage,
  test,
} from "./support/desktop";

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
  const size = {
    width: Math.max(1024, Math.min(1100, area.width)),
    height: Math.max(680, Math.min(750, area.height)),
  };
  await desktopWindow.evaluate((window, bounds) => window.setBounds(bounds), {
    x: area.x,
    y: area.y,
    ...size,
  });
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
  // The replacement plays in the film's MPV, and the film's session still closes where it was left.
  const replacement = await page.evaluate(() => window.lumen.player.timeline());
  expect(replacement.find((event) => event.kind === "player_ready")?.fields).toEqual({
    reused: true,
  });
  await expect
    .poll(() =>
      server
        .api(`/playback/sessions/${sessionId}/heartbeat`, {
          token: admin.accessToken,
          status: 409,
          body: { state: "paused", activeTrackId: state?.itemId, errorCode: null },
        })
        .then(
          () => true,
          () => false,
        ),
    )
    .toBe(true);
  expect(await server.api(`/items/${state?.itemId}`, { token: admin.accessToken })).toMatchObject({
    watchState: { positionSeconds: 5 },
  });
  // An item that cannot start lets the kept MPV go, so the next one starts a fresh player.
  await expect(page.evaluate(() => window.lumen.player.start("missing"))).rejects.toThrow();
  expect(await page.evaluate(() => window.lumen.player.state())).toBeNull();
  await page.evaluate((itemId) => window.lumen.player.start(itemId), other?.id ?? "");
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ itemId: other?.id, paused: false });
  const restarted = await page.evaluate(() => window.lumen.player.timeline());
  expect(restarted.find((event) => event.kind === "player_ready")?.fields).toEqual({
    reused: false,
  });
  await expect(
    page.evaluate((sessionId) => window.lumen.player.seek(sessionId, 2), sessionId),
  ).rejects.toThrow();
  await page.evaluate(() => window.lumen.player.stop());
  await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
  expect((await app.windows()).length).toBeGreaterThanOrEqual(1);
});

test("near the end of an episode, the next one's start is held in memory and plays from there", async ({
  server,
  admin,
  desktop,
}) => {
  // The released server a desktop release is checked against may predate preloading.
  const info = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
  test.skip(info.capabilities?.preload !== true, "The server predates preloading");
  const token = admin.accessToken;
  const library = await server.library(
    token,
    "shows",
    ["Show/Season 1/Show S01E01.mp4", "Show/Season 1/Show S01E02.mp4"],
    { "Show/Season 1/Show S01E01-thumb.png": "still.png" },
  );
  const children = async (id: string | undefined) =>
    (await server.api<{ items: { id: string }[] }>(`/items/${id}/children`, { token })).items;
  const [show] = await server.items(token, library.id);
  const [season] = await children(show?.id);
  const [first, second] = await children(season?.id);
  const { page } = desktop;
  await connectDesktop(page, server);
  await page.evaluate((route) => {
    location.hash = route;
  }, `/show/${show?.id}`);
  await page
    .getByRole("button", { name: /^Play (Show S01E01|Episode 1)$/ })
    .first()
    .click({ force: true });
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ itemId: first?.id, paused: false });
  // The episode's still gives way once MPV has a frame of the episode to show.
  await expect((await desktopPlayerPage(desktop.app)).locator(".media-player-artwork")).toHaveCount(
    0,
  );
  const state = await page.evaluate(() => window.lumen.player.state());
  const sessionId = state?.sessionId ?? "";
  await page.evaluate((id) => window.lumen.player.pause(id, true), sessionId);
  // Past the share of an episode that counts as watched, the player asks for the next one.
  await page.evaluate(({ id, at }) => window.lumen.player.seek(id, at), {
    id: sessionId,
    at: Math.floor((state?.durationSeconds ?? 0) * 0.95),
  });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.lumen.player.timeline())).find(
          (event) => event.kind === "preload_finished",
        )?.fields,
      { timeout: 15_000 },
    )
    .toEqual({ bytes: expect.any(Number), failed: false });
  await page.evaluate((itemId) => window.lumen.player.start(itemId), second?.id ?? "");
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ itemId: second?.id, paused: false });
  const adopted = (await page.evaluate(() => window.lumen.player.timeline())).find(
    (event) => event.kind === "preload_adopted",
  );
  expect(adopted?.fields.bytes).toBeGreaterThan(0);
  await page.evaluate(() => window.lumen.player.stop());
});

test("native playback prevents display sleep across fullscreen and releases it when inactive", async ({
  server,
  admin,
  desktop,
}) => {
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const { page, app } = desktop;
  const blockers = await app.evaluateHandle(({ powerSaveBlocker }) => {
    const requests: { id: number; type: string }[] = [];
    const start = powerSaveBlocker.start.bind(powerSaveBlocker);
    powerSaveBlocker.start = (type) => {
      const id = start(type);
      requests.push({ id, type });
      return id;
    };
    return {
      active: () => requests.filter(({ id }) => powerSaveBlocker.isStarted(id)),
      count: () => requests.length,
    };
  });
  const active = () => blockers.evaluate((observer) => observer.active());
  await connectDesktop(page, server);
  expect(await active()).toEqual([]);
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await expect.poll(active).toEqual([{ id: expect.any(Number), type: "prevent-display-sleep" }]);
  const initial = await active();
  for (const full of [true, false, true]) {
    await page.evaluate((enabled) => window.lumen.player.fullscreen(enabled), full);
    await expect.poll(() => page.evaluate(() => window.lumen.player.fullscreenState())).toBe(full);
    expect(await active()).toEqual(initial);
  }
  expect(await blockers.evaluate((observer) => observer.count())).toBe(1);
  const state = await page.evaluate(() => window.lumen.player.state());
  const sessionId = state?.sessionId ?? "";
  await page.evaluate((id) => window.lumen.player.pause(id, true), sessionId);
  expect(await active()).toEqual([]);
  await page.evaluate((id) => window.lumen.player.pause(id, false), sessionId);
  await expect.poll(active).toHaveLength(1);
  await page.evaluate((id) => window.lumen.player.seek(id, 10_000), sessionId);
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ ended: true });
  await expect.poll(active).toEqual([]);
  await page.evaluate((itemId) => window.lumen.player.start(itemId), state?.itemId ?? "");
  await expect.poll(active).toHaveLength(1);
  await page.evaluate(() => window.lumen.player.stop());
  expect(await active()).toEqual([]);
  await blockers.dispose();
});
