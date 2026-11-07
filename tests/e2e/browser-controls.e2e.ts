import { openMovie, pause, playing, signIn, startPlayback } from "./support/browser";
import { expect, test } from "./support/server";

test("video gestures preserve focus, double-click fullscreen never pauses, timeline seeks and controls hide", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await signIn(page, server);
  await openMovie(page, server, library.id);
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
  // Use the video region's center, away from controls and the timeline.
  const bounds = await page.getByRole("region", { name: "Media player" }).boundingBox();
  if (!bounds) throw new Error("Player is not visible");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.click(x, y);
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused))
    .toBe(true);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused))
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
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(fullscreen);
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(position + 0.5);
    await expect(page.locator("video")).toHaveAttribute("data-pauses", "0");
  }
  await pause(page);
  const timeline = page.getByRole("slider", { name: "Playback position" });
  await timeline.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0);
  await page.clock.install();
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(page.locator(".media-player-settings-panel")).toBeVisible();
  await page.mouse.move(x, y);
  await page.getByRole("button", { name: "Resume playback", exact: true }).click();
  await page.mouse.move(x + 5, y);
  await page.clock.runFor(4000);
  await expect(page.getByRole("region", { name: "Media player" })).not.toHaveClass(
    /controls-visible/,
  );
  await page.mouse.move(x + 10, y);
  await expect(page.locator(".media-player-settings-panel")).toBeHidden();
});

test("episode drawer is preloaded across seasons, marks the current range and advances naturally at EOF", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "shows", [
    "Serial/Season 1/Serial S01E01-E02 - Together.mp4",
    "Serial/Season 1/Serial S01E02 - Overlap.mp4",
    "Serial/Season 2/Serial S02E01 - Return.mp4",
  ]);
  await signIn(page, server);
  await startPlayback(page, server, library.id, ["Serial", "Season 1", "Together"]);
  await playing(page);
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Episodes" });
  await expect(drawer.getByRole("article")).toHaveCount(3);
  await expect(drawer.locator('[aria-current="true"]')).toContainText("Together");
  await expect(drawer.locator('[aria-current="true"]')).toContainText("E1–2");
  await page.keyboard.press("Escape");
  await page.route("**/api/v1/items/*/children*", (route) => route.abort());
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(drawer.getByRole("article")).toHaveCount(3);
  await drawer.getByRole("button", { name: "Play Return", exact: true }).click();
  await expect(drawer).toBeHidden();
  await playing(page);
  await expect(page.getByRole("region", { name: "Media player" })).toContainText("Return");
  await page.unroute("**/api/v1/items/*/children*");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await playing(page);
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.2;
  });
  await expect(page.getByRole("region", { name: "Media player" })).toContainText("Return");
  await playing(page);
});

const twoEpisodes = [
  "Serial/Season 1/Serial S01E01 - Opening.mp4",
  "Serial/Season 1/Serial S01E02 - Sequel.mp4",
];
const openingEpisode = ["Serial", "Season 1", "Opening"];
const itemDetails = (url: URL): boolean => /\/api\/v1\/items\/[^/]+$/.test(url.pathname);
const adjacentEpisodes = (url: URL): boolean => url.pathname.endsWith("/adjacent-episodes");

test("the player describes what is playing all at once, once every detail is known", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "shows", twoEpisodes);
  await signIn(page, server);
  const loaded = new Set<string>();
  page.on("requestfinished", (request) => loaded.add(new URL(request.url()).pathname));
  const adjacentRequested = Promise.withResolvers<string>();
  const adjacentHeld = Promise.withResolvers<void>();
  await page.route(adjacentEpisodes, async (route) => {
    adjacentRequested.resolve(new URL(route.request().url()).pathname);
    await adjacentHeld.promise;
    await route.continue();
  });
  await startPlayback(page, server, library.id, openingEpisode);
  // The episode's own details are in; only its neighbours are still being looked up.
  const episodeDetails = (await adjacentRequested.promise).replace(/\/adjacent-episodes$/, "");
  await expect.poll(() => loaded.has(episodeDetails)).toBe(true);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(header.getByRole("heading")).toHaveCount(0);
  await expect(header.locator(".media-player-title p")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toHaveCount(0);
  adjacentHeld.resolve();
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toContainText("S01E01");
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode", exact: true })).toBeVisible();
  await playing(page);
});

test("a stalled lookup does not hold back what is known, and what it brings fills in after", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "shows", twoEpisodes);
  await signIn(page, server);
  const adjacentHeld = Promise.withResolvers<void>();
  await page.route(adjacentEpisodes, async (route) => {
    await adjacentHeld.promise;
    await route.continue();
  });
  await startPlayback(page, server, library.id, openingEpisode);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toContainText("S01E01");
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
  const library = await server.library(admin.accessToken, "shows", twoEpisodes);
  await signIn(page, server);
  await startPlayback(page, server, library.id, ["Serial", "Season 1"]);
  await page.route(itemDetails, (route) => route.abort());
  await page
    .getByRole("button", { name: "Play Opening", exact: true })
    .first()
    .click({ force: true });
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toContainText("E01");
});

test("a movie is described by the item it was started from, without waiting on any lookup", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await signIn(page, server);
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

test("an older server that does not name an episode's show still offers its episodes", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "shows", twoEpisodes);
  await signIn(page, server);
  await page.route(itemDetails, async (route) => {
    const response = await route.fetch();
    const details = await response.json();
    delete details.item.seriesId;
    await route.fulfill({ response, json: details });
  });
  await startPlayback(page, server, library.id, openingEpisode);
  await playing(page);
  const header = page.locator(".media-player-header");
  await expect(header.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await expect(header.locator(".media-player-title p")).toContainText("S01E01");
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Episodes" }).getByRole("article"),
  ).toHaveCount(2);
});
