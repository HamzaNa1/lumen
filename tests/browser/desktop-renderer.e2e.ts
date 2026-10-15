import { desktopScenarios } from "./desktopScenarios";
import { expect, test } from "@playwright/test";
import type { ParityScenario } from "./desktopBridgeShim";
import {
  setupDesktopRenderer,
  desktopBuild,
  hasBaseline,
  signIn,
  openDesktop,
  gotoDesktop,
  STILL,
  settled,
  expectDesktopUnchanged,
  signedInBuilds,
  filmDisplay,
  playing,
} from "./desktopRenderer";

setupDesktopRenderer();
desktopScenarios({ includeWeb: false });

test("current and baseline renderers load episode artwork through their bridge contracts", async ({
  context,
  baseURL,
}) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const libraries = await (await context.request.get("/api/v1/libraries")).json();
  const items = await (
    await context.request.get(`/api/v1/items?libraryId=${libraries[0].id}&limit=50`)
  ).json();
  const show = items.items.find((item: { title: string }) => item.title === "Serial");
  const seasons = await (await context.request.get(`/api/v1/items/${show.id}/children`)).json();
  // A fresh fixture has no continue-watching artwork on Home; these episodes always have stills.
  for (const { page, files } of builds.desktops) {
    await gotoDesktop(page, files, `/season/${seasons.items[0].id}`);
    await settled(page);
    const posters = page.locator(".media-card img.poster");
    await expect(posters).toHaveCount(2);
    await expect
      .poll(() =>
        posters.evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          ),
        ),
      )
      .toBe(true);
  }
});

test("switching accounts keeps the new account's libraries subscribed", async ({
  context,
  baseURL,
}) => {
  await signIn(context, baseURL ?? "");
  const page = await openDesktop(context, desktopBuild);
  await page.addInitScript(() => {
    const bridge = window.lumen;
    const initial = bridge.accounts.list();
    let activeId: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { requested: false, completed: false, release };
    Reflect.set(window, "accountSwitchTest", state);
    const records = initial.then(({ accounts }) => {
      const first = accounts[0];
      if (first === undefined) throw new Error("Sign in before switching accounts");
      activeId = first.connectionId;
      return [
        first,
        {
          ...first,
          connectionId: "replacement",
          userId: "replacement-user",
          username: "replacement",
          serverName: "Replacement",
        },
      ];
    });
    Object.assign(bridge.accounts, {
      list: async () => ({ accounts: await records, activeConnectionId: activeId }),
      activate: async (id: string) => {
        await records;
        activeId = id;
        return bridge.accounts.list();
      },
    });
    Object.assign(bridge.library, {
      list: async () => {
        await records;
        const replacing = activeId === "replacement";
        if (replacing) {
          state.requested = true;
          await gate;
          state.completed = true;
        }
        return [
          {
            id: replacing ? "new-library" : "old-library",
            name: replacing ? "Replacement library" : "Original library",
            slug: "movies",
            kind: "movies",
            isEnabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ];
      },
    });
  });
  await gotoDesktop(page, desktopBuild, "/settings");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Original library" })).toBeVisible();
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Replacement/u }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "accountSwitchTest").requested))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, "accountSwitchTest").release());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "accountSwitchTest").completed))
    .toBe(true);
  await expect(nav.getByRole("link", { name: "Replacement library" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Original library" })).toHaveCount(0);
  // Repeating the transition must retain the new subscription each time.
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /admin ·/u }).click();
  await expect(nav.getByRole("link", { name: "Original library" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Replacement library" })).toHaveCount(0);
});

test("a downloaded update offers a restart that installs it", async ({ context, baseURL }) => {
  await signIn(context, baseURL ?? "");
  const page = await openDesktop(context, desktopBuild);
  await page.addInitScript(() => {
    Object.assign(window.lumen.updates, {
      ready: async () => "0.0.13",
      install: async () => {
        Reflect.set(window, "updateInstallRequested", true);
      },
    });
  });
  await gotoDesktop(page, desktopBuild, "/");
  const prompt = page.getByRole("alert").filter({ hasText: "Lumen 0.0.13 is ready" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Restart" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "updateInstallRequested")))
    .toBe(true);
});

test("the desktop player controls are what they were before the extraction", async ({
  context,
  baseURL,
}, testInfo) => {
  test.skip(!hasBaseline, "Build the pre-extraction renderer with `bun run test:browser:baseline`");
  const builds = await signedInBuilds(context, baseURL ?? "");
  // The baseline predates the time playback ends at and the Previous button, which are left out.
  const withoutLaterControls = {
    style:
      ".media-player-ends-at { visibility: hidden !important; } .media-player-transport > [aria-label='Previous'] { display: none !important; }",
  };
  const states: ReadonlyArray<readonly [string, ParityScenario]> = [
    ["starting", { display: { ...filmDisplay, loading: true, error: null } }],
    [
      "failed",
      { display: { ...filmDisplay, loading: false, error: "This file could not be played." } },
    ],
    ["playing", { display: { ...filmDisplay, loading: false, error: null }, player: playing }],
    [
      "paused and muted",
      {
        display: { ...filmDisplay, loading: false, error: null },
        player: { ...playing, paused: true, muted: true },
      },
    ],
  ];
  for (const [name, scenario] of states) {
    for (const { page, files } of builds.desktops) {
      await gotoDesktop(page, files, "/", { ...scenario, overlay: true });
      await expect(page.locator(".media-player")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({ content: STILL });
    }
    // The loading state keeps its spinner; every other state has to have stopped moving.
    await expectDesktopUnchanged(testInfo, `player ${name}`, builds, withoutLaterControls);
  }

  // The last state is still showing: open its menus.
  for (const { page } of builds.desktops)
    await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(
    builds.desktop.page.getByRole("button", { name: "Export playback diagnostics", exact: true }),
  ).toBeVisible();
  // Diagnostics now include playback failures. Compare the rest of the menu against the
  // fixed baseline while explicitly accounting for this intentional label change.
  if (builds.baseline !== null) {
    const previousLabel = builds.baseline.page.getByRole("button", {
      name: "Copy audio diagnostics",
      exact: true,
    });
    await expect(previousLabel).toBeVisible();
    await previousLabel.evaluate((button) => {
      button.textContent = "Export playback diagnostics";
    });
    // The menu has since been raised above the sliders it opens over, so its shadow now
    // falls on the volume slider instead of behind it.
    await builds.baseline.page.addStyleTag({
      content: ".media-player-settings-panel { z-index: 3; }",
    });
  }
  await expectDesktopUnchanged(testInfo, "playback settings", builds, withoutLaterControls);
  for (const { page } of builds.desktops) {
    await page.getByRole("button", { name: "Playback settings", exact: true }).click();
    await page.locator(".watch-group-chip").click();
    await expect(page.getByText("No groups yet")).toBeVisible();
  }
  await expectDesktopUnchanged(
    testInfo,
    "watch groups in the player",
    builds,
    withoutLaterControls,
  );
});

test("the playback settings open over the timeline", async ({ context, baseURL }, testInfo) => {
  const { page } = (await signedInBuilds(context, baseURL ?? "")).desktop;
  // Far enough along that the played part of the timeline, and its thumb, run under the panel.
  await gotoDesktop(page, desktopBuild, "/", {
    overlay: true,
    display: { ...filmDisplay, loading: false, error: null },
    player: { ...playing, positionSeconds: 92 },
  });
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  const panel = page.locator(".media-player-settings-panel");
  await expect(panel).toBeVisible();
  await page.addStyleTag({ content: STILL });
  await testInfo.attach("playback settings over the timeline", {
    body: await page.locator(".media-player-console").screenshot(),
    contentType: "image/png",
  });

  const thumb = await page.locator(".media-player-timeline .media-slider-thumb").boundingBox();
  const bounds = await panel.boundingBox();
  if (thumb === null || bounds === null) throw new Error("The timeline or the panel is not drawn");
  const point = { x: thumb.x + thumb.width / 2, y: thumb.y + 1 };
  expect(point.x).toBeGreaterThan(bounds.x);
  expect(point.y).toBeLessThan(bounds.y + bounds.height);
  const topmost = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".media-player-settings-panel") !== null,
    point,
  );
  expect(topmost, "the settings panel is drawn over the timeline's thumb").toBe(true);
});

test("hovering the timeline shows the time under the pointer", async ({
  context,
  baseURL,
}, testInfo) => {
  const { page } = (await signedInBuilds(context, baseURL ?? "")).desktop;
  await gotoDesktop(page, desktopBuild, "/", {
    overlay: true,
    display: { ...filmDisplay, duration: 5_400, loading: false, error: null },
    player: { ...playing, positionSeconds: 1_200, durationSeconds: 5_400, bufferedRanges: [] },
  });
  const hover = page.locator(".media-player-timeline-hover");
  const control = await page.locator(".media-player-timeline .media-slider-control").boundingBox();
  if (control === null) throw new Error("The timeline is not drawn");
  const y = control.y + control.height / 2;
  await expect(hover).toHaveCount(0);

  await page.mouse.move(control.x + control.width * 0.75, y);
  await expect(hover).toHaveText("1:07:30");
  const label = await hover.boundingBox();
  if (label === null) throw new Error("The hovered time is not drawn");
  expect(Math.abs(label.x + label.width / 2 - (control.x + control.width * 0.75))).toBeLessThan(2);
  expect(label.y + label.height).toBeLessThanOrEqual(control.y);
  await testInfo.attach("timeline hover", {
    body: await page.locator(".media-player-console").screenshot(),
    contentType: "image/png",
  });

  await page.mouse.move(control.x + control.width * 0.1, y);
  // The pointer lands on a whole pixel, which can fall a moment short of the tenth it aims for.
  await expect(hover).toHaveText(/^(8:59|9:00)$/u);
  await testInfo.attach("timeline hover near the start", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Hovering only previews a time; playback stays where it was.
  await expect(page.locator(".media-player-time").first()).toHaveText("20:00");
  await page.mouse.move(control.x + control.width / 2, control.y - 200);
  await expect(hover).toHaveCount(0);
});

test("pressing the edge of the timeline's thumb seeks to the pointer", async ({
  context,
  baseURL,
}) => {
  const { page } = (await signedInBuilds(context, baseURL ?? "")).desktop;
  await gotoDesktop(page, desktopBuild, "/", {
    overlay: true,
    display: { ...filmDisplay, duration: 5_400, loading: false, error: null },
    player: { ...playing, positionSeconds: 1_200, durationSeconds: 5_400, bufferedRanges: [] },
  });
  const elapsed = page.locator(".media-player-time").first();
  await expect(elapsed).toHaveText("20:00");
  const thumb = await page.locator(".media-player-timeline .media-slider-thumb").boundingBox();
  if (thumb === null) throw new Error("The timeline's thumb is not drawn");
  const y = thumb.y + thumb.height / 2;

  await page.mouse.move(thumb.x + thumb.width - 1, y);
  await page.mouse.down();
  await expect(elapsed).toHaveText(/^20:(0[1-9]|[1-5]\d)$/u);
  await page.mouse.up();

  await page.mouse.move(thumb.x + 1, y);
  await page.mouse.down();
  await expect(elapsed).toHaveText(/^19:\d\d$/u);
  await page.mouse.up();
});
