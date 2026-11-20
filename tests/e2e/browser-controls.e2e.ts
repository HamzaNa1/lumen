import type { Page } from "@playwright/test";
import { often, openMovie, pause, playing, signIn, startPlayback } from "./support/browser";
import { expect, test } from "./support/server";

test("video gestures preserve focus, double-click fullscreen never pauses, timeline seeks and controls hide", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "movies", ["Film.mp4"]),
    signIn(page, server),
  ]);
  await openMovie(page, server, library.id);
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
  // Use the video region's center, away from controls and the timeline.
  const bounds = await page.getByRole("region", { name: "Media player" }).boundingBox();
  if (!bounds) throw new Error("Player is not visible");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.click(x, y);
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused), often)
    .toBe(true);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused), often)
    .toBe(false);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.dataset.pauses = "0";
    v.addEventListener("pause", () => {
      v.dataset.pauses = String(Number(v.dataset.pauses) + 1);
    });
  });
  for (const fullscreen of [true, false]) {
    const position = await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.mouse.dblclick(x, y);
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)), often)
      .toBe(fullscreen);
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime), often)
      .toBeGreaterThan(position + 0.5);
    await expect(page.locator("video")).toHaveAttribute("data-pauses", "0");
  }
  await pause(page);
  const audioState = () =>
    page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => ({ volume: Math.round(v.volume * 100), muted: v.muted }));
  // Arrow keys and M adjust volume and mute from the player; rapid repeats never drop steps.
  await expect.poll(audioState, often).toEqual({ volume: 100, muted: false });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(audioState, often).toEqual({ volume: 90, muted: false });
  await page.keyboard.press("ArrowUp");
  await expect.poll(audioState, often).toEqual({ volume: 95, muted: false });
  await page.keyboard.press("m");
  await expect.poll(audioState, often).toEqual({ volume: 95, muted: true });
  await expect(page.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
  await page.keyboard.press("m");
  await expect.poll(audioState, often).toEqual({ volume: 95, muted: false });
  await expect(page.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  // Raising volume while muted unmutes; lowering to zero mutes and M brings back audible volume.
  await page.keyboard.press("m");
  await expect.poll(audioState, often).toEqual({ volume: 95, muted: true });
  await page.keyboard.press("ArrowUp");
  await expect.poll(audioState, often).toEqual({ volume: 100, muted: false });
  const volumeSlider = page.getByRole("slider", { name: "Volume" });
  await volumeSlider.focus();
  await page.keyboard.press("Home");
  await expect.poll(audioState, often).toEqual({ volume: 0, muted: true });
  // Pressing M even while the volume slider has focus still unmutes to an audible level.
  await page.keyboard.press("m");
  await expect.poll(audioState, often).toEqual({ volume: 5, muted: false });
  await volumeSlider.blur();
  await page.keyboard.press("ArrowDown");
  await expect.poll(audioState, often).toEqual({ volume: 0, muted: true });
  await page.keyboard.press("ArrowUp");
  await expect.poll(audioState, often).toEqual({ volume: 5, muted: false });
  await page.mouse.move(x, y);
  // Wheel up raises and wheel down lowers volume; smooth trackpad ticks throttle, horizontal and
  // pinch-zoom wheels are ignored.
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect.poll(audioState, often).toEqual({ volume: 15, muted: false });
  await page.mouse.wheel(0, 100);
  await expect.poll(audioState, often).toEqual({ volume: 10, muted: false });
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++)
      window.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -10, bubbles: true, cancelable: true }),
      );
  });
  await expect.poll(audioState, often).toEqual({ volume: 15, muted: false });
  await page.mouse.wheel(120, 0);
  await page.evaluate(() => {
    window.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(audioState, often).toEqual({ volume: 15, muted: false });
  const timeline = page.getByRole("slider", { name: "Playback position" });
  await timeline.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime), often)
    .toBeGreaterThan(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(audioState, often).toEqual({ volume: 15, muted: false });
  // Clicking the end-of-timeline time toggles between remaining time and total duration.
  const durationSeconds = await page
    .locator("video")
    .evaluate((v: HTMLVideoElement) => Math.floor(v.duration));
  const durationText = `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, "0")}`;
  const toDuration = page.getByRole("button", { name: "Show total duration", exact: true });
  await expect(toDuration).toHaveText(/^-\d+:\d{2}$/u);
  await expect(toDuration).not.toHaveText(`-${durationText}`);
  await toDuration.click();
  const toRemaining = page.getByRole("button", { name: "Show remaining time", exact: true });
  await expect(toRemaining).toHaveText(durationText);
  // Pressing Space while the toggle has focus switches it back without resuming playback.
  await page.keyboard.press("Space");
  await expect(toDuration).toHaveText(/^-\d+:\d{2}$/u);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await toDuration.blur();
  await page.clock.install();
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(page.locator(".media-player-settings-panel")).toBeVisible();
  // Scrolling over the settings panel does not change volume.
  const panelBox = await page.locator(".media-player-settings-panel").boundingBox();
  if (!panelBox) throw new Error("Settings panel is not visible");
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(audioState, often).toEqual({ volume: 15, muted: false });
  await page.mouse.move(x, y);
  await page.getByRole("button", { name: "Resume playback", exact: true }).click();
  await page.mouse.move(x + 5, y);
  await page.clock.runFor(4000);
  await expect(page.getByRole("region", { name: "Media player" })).not.toHaveClass(
    /controls-visible/,
  );
  // Adjusting volume or muting while controls are hidden reveals them again, then hides after idle.
  await page.mouse.wheel(0, -100);
  await expect.poll(audioState, often).toEqual({ volume: 20, muted: false });
  await expect(page.getByRole("region", { name: "Media player" })).toHaveClass(/controls-visible/);
  await page.clock.runFor(4000);
  await expect(page.getByRole("region", { name: "Media player" })).not.toHaveClass(
    /controls-visible/,
  );
  await page.keyboard.press("m");
  await expect.poll(audioState, often).toEqual({ volume: 20, muted: true });
  await expect(page.getByRole("region", { name: "Media player" })).toHaveClass(/controls-visible/);
  await page.mouse.move(x + 10, y);
  await expect(page.locator(".media-player-settings-panel")).toBeHidden();
});

test("episode drawer is preloaded across seasons, marks the current range and advances naturally at EOF", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", [
      "Serial/Season 1/Serial S01E01-E02 - Together.mp4",
      "Serial/Season 1/Serial S01E02 - Overlap.mp4",
      "Serial/Season 2/Serial S02E01 - Return.mp4",
    ]),
    signIn(page, server),
  ]);
  // The player also names the episode after this one, so only its heading says what plays, and
  // only a new source shows that it is the episode playing and not the end of the one before.
  const title = page.locator(".media-player-header").getByRole("heading");
  const source = () => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentSrc);
  let before = "";
  const plays = async (episode: string) => {
    await expect(title).toHaveText(episode);
    await expect.poll(source, often).not.toBe(before);
    await playing(page);
    before = await source();
  };
  await startPlayback(page, server, library.id, ["Serial", "Season 1", "Together"]);
  await plays("Together");
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Episodes" });
  await expect(drawer.getByRole("article")).toHaveCount(3);
  await expect(drawer.locator('[aria-current="true"]')).toContainText("Together");
  await expect(drawer.locator('[aria-current="true"]')).toContainText("E1–2");
  // Scrolling inside the open episode drawer does not change playback volume. Linux WebKit starts
  // a stream at the volume PulseAudio last saw, which parallel workers share, so compare to it.
  const volume = () => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume);
  const startVolume = await volume();
  const drawerBox = await drawer.boundingBox();
  if (!drawerBox) throw new Error("Drawer is not visible");
  await page.mouse.move(drawerBox.x + drawerBox.width / 2, drawerBox.y + drawerBox.height / 2);
  await page.mouse.wheel(0, 100);
  await expect.poll(volume, often).toBe(startVolume);
  await page.keyboard.press("Escape");
  await page.route("**/api/v1/items/*/children*", (route) => route.abort());
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(drawer.getByRole("article")).toHaveCount(3);
  await drawer.getByRole("button", { name: "Play Return", exact: true }).click();
  await expect(drawer).toBeHidden();
  await plays("Return");
  await page.unroute("**/api/v1/items/*/children*");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await plays("Overlap");
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.2;
  });
  await plays("Return");
  // The chosen time display persists across episodes and full page reloads, in either direction.
  await page.getByRole("button", { name: "Show total duration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show remaining time", exact: true })).toHaveText(
    /^\d+:\d{2}$/u,
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await plays("Overlap");
  await expect(page.getByRole("button", { name: "Show remaining time", exact: true })).toHaveText(
    /^\d+:\d{2}$/u,
  );
  await page.reload();
  await startPlayback(page, server, library.id, ["Serial", "Season 1", "Together"]);
  await plays("Together");
  const showRemaining = page.getByRole("button", { name: "Show remaining time", exact: true });
  await expect(showRemaining).toHaveText(/^\d+:\d{2}$/u);
  await showRemaining.click();
  await expect(page.getByRole("button", { name: "Show total duration", exact: true })).toHaveText(
    /^-\d+:\d{2}$/u,
  );
  await page.reload();
  await startPlayback(page, server, library.id, ["Serial", "Season 1", "Together"]);
  await plays("Together");
  await expect(page.getByRole("button", { name: "Show total duration", exact: true })).toHaveText(
    /^-\d+:\d{2}$/u,
  );
});

const twoEpisodes = [
  "Serial/Season 1/Serial S01E01 - Opening.mp4",
  "Serial/Season 1/Serial S01E02 - Sequel.mp4",
];
const openingEpisode = ["Serial", "Season 1", "Opening"];
const itemDetails = (url: URL): boolean => /\/api\/v1\/items\/[^/]+$/.test(url.pathname);
const adjacentEpisodes = (url: URL): boolean => url.pathname.endsWith("/adjacent-episodes");

/** Waits out the season page's own lookups, so routes added after see only the player's. */
async function seasonShown(page: Page) {
  await expect(page.getByRole("heading", { name: "Season 1", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Serial", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play Opening", exact: true }).first(),
  ).toBeVisible();
}

/** Answers like a server too old to place an episode in its show. */
async function asOlderServer(page: Page) {
  await page.route(
    (url) => /\/api\/v1\/(items|home)(\/|$)/.test(url.pathname),
    async (route) => {
      // A page that navigates away, or a test that ends, abandons its requests and responses.
      const response = await route.fetch().catch(() => null);
      const text = response === null ? null : await response.text().catch(() => null);
      if (response === null || text === null) return route.abort().catch(() => undefined);
      const body = JSON.parse(text, (key, value) => (key === "placement" ? undefined : value));
      await route.fulfill({ response, json: body });
    },
  );
}

test("a season plays its next episode, names the one it resumes, and starts over once watched", async ({
  server,
  admin,
  page,
}) => {
  const token = admin.accessToken;
  const children = async (id: string | undefined) =>
    (await server.api<{ items: Array<{ id: string }> }>(`/items/${id}/children`, { token })).items;
  const watch = (id: string | undefined, positionSeconds: number, completed: boolean) =>
    server.api(`/items/${id}/watch-state`, {
      token,
      method: "PUT",
      body: { positionSeconds, completed },
    });
  const [{ show, seasonOne, seasonTwo, sequel }] = await Promise.all([
    (async () => {
      const library = await server.library(token, "shows", [
        ...twoEpisodes,
        "Serial/Season 2/Serial S02E01 - Return.mp4",
      ]);
      const [show] = await server.items(token, library.id);
      const [seasonOne, seasonTwo] = await children(show?.id);
      const [opening, sequel] = await children(seasonOne?.id);
      await Promise.all([watch(opening?.id, 0, true), watch(sequel?.id, 2, false)]);
      return { show, seasonOne, seasonTwo, sequel };
    })(),
    signIn(page, server),
  ]);
  const actions = page.locator(".details-actions");
  for (const path of [`show/${show?.id}`, `season/${seasonOne?.id}`, `episode/${sequel?.id}`]) {
    await page.goto(`${server.origin}web/${path}`);
    await expect(actions.getByRole("button", { name: "Resume S1 E2", exact: true })).toBeVisible();
  }
  await page.goto(`${server.origin}web/season/${seasonTwo?.id}`);
  await expect(actions.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await watch(seasonOne?.id, 0, true);
  await page.goto(`${server.origin}web/season/${seasonOne?.id}`);
  await actions.getByRole("button", { name: "Play", exact: true }).click();
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
});

test("an episode, and the one after it, are described the moment they play", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes),
    signIn(page, server),
  ]);
  await startPlayback(page, server, library.id, ["Serial", "Season 1"]);
  await seasonShown(page);
  const detailsLookups: string[] = [];
  const lookupsHeld = Promise.withResolvers<void>();
  await page.route(itemDetails, async (route) => {
    detailsLookups.push(route.request().url());
    await lookupsHeld.promise;
    await route.fallback();
  });
  const neighboursHeld = Promise.withResolvers<void>();
  await page.route(adjacentEpisodes, async (route) => {
    await neighboursHeld.promise;
    await route.fallback();
  });
  await page
    .getByRole("button", { name: "Play Opening", exact: true })
    .first()
    .click({ force: true });
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toHaveText("Serial · S01E01");
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toBeVisible();
  await playing(page);
  // The neighbours fetched while it plays come placed in turn.
  const neighbours = page.waitForResponse((response) => adjacentEpisodes(new URL(response.url())));
  neighboursHeld.resolve();
  await neighbours;
  await page.getByRole("button", { name: "Next episode", exact: true }).click();
  await expect(header.getByRole("heading", { name: "Sequel", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toHaveText("Serial · S01E02");
  expect(detailsLookups).toEqual([]);
  lookupsHeld.resolve();
});

test("an episode's still covers the player until the episode, or the one after it, plays", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes, {
      "Serial/Season 1/Serial S01E01 - Opening-thumb.png": "still.png",
      "Serial/Season 1/Serial S01E02 - Sequel-thumb.png": "still.png",
    }),
    signIn(page, server),
  ]);
  let held = Promise.withResolvers<void>();
  await page.route("**/api/v1/playback/sessions", async (route) => {
    await held.promise;
    await route.fallback();
  });
  const still = page.locator(".media-player-artwork");
  await startPlayback(page, server, library.id, openingEpisode);
  // The still fills the player, so it asks for the largest width the server scales to.
  await expect(still).toHaveAttribute("src", /\/api\/v1\/artwork\/.*[?&]width=1920/);
  const openingStill = await still.getAttribute("src");
  held.resolve();
  await playing(page);
  await expect(still).toHaveCount(0);

  held = Promise.withResolvers<void>();
  await page.getByRole("button", { name: "Next episode", exact: true }).click();
  await expect(still).toHaveAttribute("src", /\/api\/v1\/artwork\//);
  expect(await still.getAttribute("src")).not.toBe(openingStill);
  held.resolve();
  await playing(page);
  await expect(still).toHaveCount(0);
});

test("an older server's episode is described all at once, once every detail is known", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes),
    signIn(page, server),
  ]);
  await asOlderServer(page);
  const loaded = new Set<string>();
  page.on("requestfinished", (request) => loaded.add(new URL(request.url()).pathname));
  const adjacentRequested = Promise.withResolvers<string>();
  const adjacentHeld = Promise.withResolvers<void>();
  await page.route(adjacentEpisodes, async (route) => {
    adjacentRequested.resolve(new URL(route.request().url()).pathname);
    await adjacentHeld.promise;
    await route.fallback();
  });
  await startPlayback(page, server, library.id, openingEpisode);
  // The episode's own details are in; only its neighbours are still being looked up.
  const episodeDetails = (await adjacentRequested.promise).replace(/\/adjacent-episodes$/, "");
  await expect.poll(() => loaded.has(episodeDetails), often).toBe(true);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(header.getByRole("heading")).toHaveCount(0);
  await expect(header.locator(".media-player-title p")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toHaveCount(0);
  adjacentHeld.resolve();
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toHaveText("Serial · S01E01");
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toBeVisible();
  await playing(page);
});

test("a stalled lookup does not hold back what is known, and what it brings fills in after", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes),
    signIn(page, server),
  ]);
  await asOlderServer(page);
  await page.clock.install();
  const adjacentRequested = Promise.withResolvers<void>();
  const adjacentHeld = Promise.withResolvers<void>();
  await page.route(adjacentEpisodes, async (route) => {
    adjacentRequested.resolve();
    await adjacentHeld.promise;
    await route.fallback();
  });
  await startPlayback(page, server, library.id, openingEpisode);
  // The player starts waiting out its lookups in the render that requests them.
  await adjacentRequested.promise;
  await page.clock.fastForward(1_500);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toHaveText("Serial · S01E01");
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toHaveCount(0);
  adjacentHeld.resolve();
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toBeVisible();
});

test("an episode whose details cannot be read is described by the item it was started from", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes),
    signIn(page, server),
  ]);
  await asOlderServer(page);
  await page.clock.install();
  await startPlayback(page, server, library.id, ["Serial", "Season 1"]);
  await seasonShown(page);
  const failed = Promise.withResolvers<void>();
  await page.route(itemDetails, async (route) => {
    await route.abort();
    failed.resolve();
  });
  await page
    .getByRole("button", { name: "Play Opening", exact: true })
    .first()
    .click({ force: true });
  // Reads are retried once, a second after they fail.
  await failed.promise;
  await page.clock.fastForward(1_000);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toContainText("E01");
});

test("a movie is described by the item it was started from, without waiting on any lookup", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "movies", ["Film.mp4"]),
    signIn(page, server),
  ]);
  const lookups: string[] = [];
  await page.route(
    (url) => itemDetails(url) || adjacentEpisodes(url),
    (route) => {
      lookups.push(route.request().url());
      return route.abort();
    },
  );
  await openMovie(page, server, library.id);
  await expect(
    page.locator(".media-player-header").getByRole("heading", { name: "Film", exact: true }),
  ).toBeVisible();
  expect(lookups).toEqual([]);
});

test("an older server's episode still offers the episodes of its show", async ({
  server,
  admin,
  page,
}) => {
  const [library] = await Promise.all([
    server.library(admin.accessToken, "shows", twoEpisodes),
    signIn(page, server),
  ]);
  await asOlderServer(page);
  await startPlayback(page, server, library.id, openingEpisode);
  await playing(page);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toHaveText("Serial · S01E01");
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Episodes" }).getByRole("article"),
  ).toHaveCount(2);
});
