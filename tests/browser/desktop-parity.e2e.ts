import { type Page, expect, test } from "@playwright/test";
import {
  setupDesktopRenderer,
  desktopBuild,
  gotoDesktop,
  STILL,
  expectAlike,
  signedInBuilds,
  playing,
} from "./desktopRenderer";
import { desktopScenarios } from "./desktopScenarios";

setupDesktopRenderer();
desktopScenarios({ includeWeb: true });

test("the player controls are drawn identically over playing media", async ({
  context,
  baseURL,
}, testInfo) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const { web, desktop } = builds;
  await web.page.goto("/web/library");
  await web.page.getByRole("button", { name: "Play Film" }).first().click({ force: true });
  await expect(web.page.getByRole("region", { name: "Media player" })).toBeVisible();
  // Headless browsers refuse unprompted playback with sound; the player then asks for a click.
  const start = web.page.getByRole("button", { name: "Play", exact: true });
  if (await start.isVisible().catch(() => false)) await start.click();
  const video = (): Promise<{
    readonly paused: boolean;
    readonly positionSeconds: number;
    readonly durationSeconds: number;
    readonly bufferedRanges: { startSeconds: number; endSeconds: number }[];
    readonly volume: number;
    readonly muted: boolean;
  } | null> =>
    web.page.evaluate(() => {
      const element = document.querySelector("video");
      if (element === null) return null;
      const bufferedRanges = [];
      for (let index = 0; index < element.buffered.length; index += 1)
        bufferedRanges.push({
          startSeconds: element.buffered.start(index),
          endSeconds: element.buffered.end(index),
        });
      return {
        paused: element.paused,
        positionSeconds: element.currentTime,
        durationSeconds: element.duration,
        bufferedRanges,
        volume: Math.round(element.volume * 100),
        muted: element.muted,
      };
    });
  await expect.poll(async () => (await video())?.positionSeconds ?? 0).toBeGreaterThan(0.2);
  await web.page.mouse.move(300, 300);
  await web.page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect.poll(async () => (await video())?.paused).toBe(true);
  // The whole file is short enough to finish buffering; wait so the picture cannot change.
  await web.page.waitForLoadState("networkidle");
  const element = await video();
  if (element === null) throw new Error("The web build is not playing");

  // The desktop's controls window is told the same thing the browser's player reports.
  const header = web.page.locator(".media-player-title");
  await gotoDesktop(desktop.page, desktopBuild, "/", {
    overlay: true,
    display: {
      itemId: null,
      title: await header.locator("h1").innerText(),
      context:
        (await header.locator("p").count()) === 0 ? "" : await header.locator("p").innerText(),
      duration: Math.round(element.durationSeconds),
      loading: false,
      error: null,
      hasPreviousEpisode: false,
      nextEpisode: null,
    },
    player: { ...playing, ...element, streams: [], selectedAudioStreamId: null },
  });
  await expect(desktop.page.locator(".media-player")).toBeVisible();

  // The controls sit over the video, which only the browser build draws into the page.
  const withoutVideo = `${STILL} video { visibility: hidden !important; } html, body, #root, .watch-page, .player-overlay { background: #000 !important; }`;
  for (const { page } of [web, desktop]) await page.addStyleTag({ content: withoutVideo });
  // The controls fade once the pointer rests.
  let nudge = 0;
  const keepControls = async (page: Page): Promise<void> => {
    nudge += 1;
    await page.mouse.move(300 + (nudge % 2), 300);
  };
  for (const region of [".media-player-header", ".media-player-console"])
    await expectAlike(testInfo, "paused player", region, [web, desktop], { before: keepControls });

  await web.page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(web.page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});
