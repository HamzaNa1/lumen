import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  openMovie,
  openPlaybackInfo,
  openSettings,
  pause,
  playbackInfoValue,
  playing,
  settingsValue,
  signIn,
  startPlayback,
} from "./support/browser";
import { openDatabase } from "./support/database";
import { encode } from "./support/encode";
import { NetworkProxy } from "./support/proxy";
import { expect, serverVersion, test } from "./support/server";

/** Conversion as one stream: the path of browsers without MediaSource, and of "Original". */
const requireConversion = (page: Page, webm = false) =>
  page.addInitScript((webm) => {
    for (const name of ["MediaSource", "ManagedMediaSource"]) Reflect.deleteProperty(window, name);
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type.includes("matroska") || (webm && type.includes("mp4"))
        ? ""
        : canPlayType.call(this, type);
    };
  }, webm);

test("browser sign-in protects cookies, restores routes and propagates logout across tabs", async ({
  server,
  admin: _admin,
  page,
  context,
}) => {
  await signIn(page, server);
  const cookie = (await context.cookies()).find((cookie) => cookie.name === "lumen_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
  expect(
    await page.evaluate(() =>
      JSON.stringify({ cookie: document.cookie, localStorage, sessionStorage }),
    ),
  ).not.toContain(cookie?.value ?? "missing");
  for (const path of ["search", "settings", "admin", "admin/users", "admin/jobs", "library"]) {
    await page.goto(`${server.origin}web/${path}`);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".page").first()).toBeVisible();
  }
  // Settings opens over the page the viewer is on and closes back to it.
  await page.goto(`${server.origin}web/search`);
  const settings = await openSettings(page);
  const categories = settings.getByRole("navigation", { name: "Settings" });
  await expect(categories.getByRole("button")).toHaveText([
    "Playback",
    "About",
    "General",
    "Transcoding",
  ]);
  // The web app ships inside its server, so it reports the server's version, and has no MPV.
  await categories.getByRole("button", { name: "About" }).click();
  await expect(settingsValue(settings, "App")).toHaveText(serverVersion);
  await expect(settingsValue(settings, "Server")).toHaveText(serverVersion);
  await expect(settings.getByText("MPV", { exact: true })).toHaveCount(0);
  await categories.getByRole("button", { name: "General" }).click();
  await expect(settings.getByRole("button", { name: "Rename…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page).toHaveURL(/\/web\/search$/);
  const other = await context.newPage();
  await other.goto(`${server.origin}web/settings`);
  await expect(other.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.goto(`${server.origin}web/settings`);
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Sign out/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("real playback supports controls, fullscreen, buffering, diagnostics and teardown without exposing grants", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film (2019).mp4"]);
  await signIn(page, server);
  await openMovie(page, server, library.id);
  const video = page.locator("video");
  // WebKit may report a wait and never say playback resumed; the moving clock says so instead.
  const player = page.getByRole("region", { name: "Media player" });
  const hold = (types: string) =>
    page.evaluate((types) => {
      document.documentElement.dataset.heldMediaEvents = types;
    }, types);
  await page.evaluate(() => {
    for (const type of ["timeupdate", "playing", "canplay", "seeked"])
      window.addEventListener(
        type,
        (event) => {
          const held = document.documentElement.dataset.heldMediaEvents?.split(" ") ?? [];
          if (held.includes(type)) event.stopImmediatePropagation();
        },
        true,
      );
  });
  await hold("timeupdate playing canplay seeked");
  await video.evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event("waiting")));
  await expect(player).toHaveAttribute("data-status", "buffering");
  await hold("playing canplay seeked");
  await expect(player).toHaveAttribute("data-status", "ready");
  await hold("");
  const exposure = await page.evaluate(() => ({
    location: location.href,
    storage: JSON.stringify({ localStorage, sessionStorage }),
    source: document.querySelector("video")?.src,
  }));
  expect(exposure.source).toContain("grant=");
  expect(exposure.location).not.toContain("grant");
  expect(exposure.storage).not.toContain("grant");
  await pause(page);
  await expect(page.getByText(/^Ends at \d{1,2}:\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode" })).toHaveCount(0);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  const volume = page.getByRole("slider", { name: "Volume" });
  await volume.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.volume)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.volume)).toBe(1);
  const info = await openPlaybackInfo(page);
  await expect(info).toContainText("Video resolution");
  await expect(playbackInfoValue(info, "Play method")).toHaveText("Direct play");
  await expect(playbackInfoValue(info, "Buffered ahead")).toHaveText(/^(\d+\.\d s|To the end)$/);
  // Outside a watch group there is nothing to keep in step with.
  await expect(info.getByRole("heading", { name: "Sync" })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, "copiedPlaybackInfo", text);
        },
      },
    });
  });
  await info.getByRole("button", { name: "Copy playback info" }).click();
  await expect(info.getByRole("button", { name: "Copied playback info" })).toBeVisible();
  const copied = String(await page.evaluate(() => Reflect.get(window, "copiedPlaybackInfo")));
  expect(copied).toContain("  Play method: Direct play");
  expect(copied).toMatch(/ {2}Session ID: [0-9a-f-]{36}/u);
  // A report a viewer pastes anywhere must not carry what fetches the media.
  expect(copied).not.toContain("grant");
  expect(copied).not.toMatch(/https?:\/\//u);
  await page.mouse.move(310, 310);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(video).toHaveCount(0);
});

test("playback info never shows what was buffered at the position a seek leaves", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", []);
  const file = join(library.path, "Film.mp4");
  await encode(
    [
      ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "40"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart"],
    ],
    file,
  );
  await server.scan(admin.accessToken, library.id);
  // Serve about four seconds so one ten-second seek leaves the buffer. Keep the response
  // open since a browser may take an early end of the response as the end of the file.
  const byteLimit = Math.round(statSync(file).size / 10);
  const done = Promise.withResolvers<void>();
  const proxy = await new NetworkProxy(server.origin).start();
  proxy.intercept = async (request, response) => {
    if (request.method !== "GET" || !/^\/api\/v1\/media\/[^/?]+(?:\?|$)/u.test(request.url ?? ""))
      return false;
    const start = Number(/^bytes=(\d+)-/u.exec(request.headers.range ?? "")?.[1] ?? 0);
    const upstream = await fetch(new URL(request.url ?? "/", proxy.upstream), {
      headers: { cookie: request.headers.cookie ?? "", range: request.headers.range ?? "bytes=0-" },
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    let allowance = Math.max(0, byteLimit - start);
    for await (const chunk of upstream.body ?? []) {
      const part = Buffer.from(chunk).subarray(0, allowance);
      allowance -= part.length;
      response.write(part);
      if (allowance <= 0) {
        await done.promise;
        break;
      }
    }
    response.end();
    return true;
  };
  try {
    await signIn(page, proxy);
    await openMovie(page, proxy, library.id);
    await pause(page);
    const info = await openPlaybackInfo(page);
    const buffered = playbackInfoValue(info, "Buffered ahead");
    await expect.poll(async () => Number.parseFloat(await buffered.innerText())).toBeGreaterThan(0);
    // Every position the player shows, beside what the panel says is buffered ahead of it.
    await page.evaluate(() => {
      const shown: string[] = [];
      Reflect.set(window, "shownBuffer", shown);
      const read = () => {
        const position = document.querySelector(".media-player-time")?.textContent;
        const row = [...document.querySelectorAll(".media-player-info dl > div")].find(
          (row) => row.querySelector("dt")?.textContent === "Buffered ahead",
        );
        shown.push(`${position} ${row?.querySelector("dd")?.textContent}`);
      };
      new MutationObserver(read).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page.mouse.move(300, 300);
    await page.getByRole("button", { name: "Forward 10 seconds" }).click();
    await expect(page.locator(".media-player-time").first()).toHaveText(/^0:1\d$/u);
    await expect(buffered).toHaveText("0.0 s");
    const shown = (await page.evaluate(() => Reflect.get(window, "shownBuffer"))) as string[];
    expect(shown.filter((entry) => /^0:1\d /u.test(entry) && !entry.endsWith(" 0.0 s"))).toEqual(
      [],
    );
  } finally {
    done.resolve();
    await proxy.close();
  }
});

test("each title remembers volume and episode navigation crosses seasons and skips combined overlaps", async ({
  server,
  admin,
  page,
}) => {
  const token = admin.accessToken;
  const movies = await server.library(token, "movies", ["Film.mp4"]);
  const shows = await server.library(token, "shows", [
    "Serial/Season 1/Serial S01E01 - Pilot.mp4",
    "Serial/Season 1/Serial S01E02-E03 - Together.mp4",
    "Serial/Season 1/Serial S01E03 - Overlap.mp4",
    "Serial/Season 2/Serial S02E01 - Return.mp4",
  ]);
  await signIn(page, server);
  const episode = async (season: string, title: string) => {
    await startPlayback(page, server, shows.id, ["Serial", season, title]);
    await playing(page);
    await pause(page);
  };
  const setVolume = async (value: number) => {
    await page.getByRole("slider", { name: "Volume" }).focus();
    await page.keyboard.press("End");
    for (let level = 100; level > value; level -= 10) await page.keyboard.press("PageDown");
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
      .toBeCloseTo(value / 100);
  };
  await episode("Season 1", "Pilot");
  await setVolume(30);
  await openMovie(page, server, movies.id);
  await pause(page);
  await setVolume(80);
  await episode("Season 2", "Return");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
    .toBeCloseTo(0.3);
  await episode("Season 1", "Together");
  await page.getByRole("button", { name: "Next episode", exact: true }).click();
  await playing(page);
  await expect(page.getByRole("region", { name: "Media player" })).toContainText("Return");
  await page.reload();
  await openMovie(page, server, movies.id);
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
    .toBeCloseTo(0.8);
});

test("revoked browser sessions return to sign-in and allow a fresh account session", async ({
  server,
  admin,
  page,
  context,
}) => {
  expect(admin.accessToken).toBeTruthy();
  await signIn(page, server);
  const cookie = (await context.cookies()).find((cookie) => cookie.name === "lumen_session");
  const logout = await server.request("/api/v1/auth/browser/logout", {
    method: "POST",
    headers: {
      cookie: `lumen_session=${cookie?.value}`,
      origin: new URL(server.origin).origin,
      "x-lumen-csrf": "1",
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(logout.status).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await signIn(page, server);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "lumen_session")?.value,
  ).not.toBe(cookie?.value);
});

test("older server capabilities keep playback and settings usable without unsupported track or watch requests", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const unsupported: string[] = [];
  page.on("request", (request) => {
    if (
      /track-preferences|track-choice|adjacent-episodes|watch-groups|directories/.test(
        request.url(),
      )
    )
      unsupported.push(request.url());
  });
  await page.route("**/api/v1/server", async (route) => {
    const response = await route.fetch();
    const identity = await response.json();
    delete identity.capabilities;
    await route.fulfill({ response, json: identity });
  });
  await signIn(page, server);
  await openSettings(page);
  await page.keyboard.press("Escape");
  await openMovie(page, server, library.id);
  await pause(page);
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Playback info", exact: true })).toBeVisible();

  const typed = join(server.root, "typed");
  const moved = join(server.root, "moved");
  await mkdir(typed);
  await mkdir(moved);
  await page.goto(`${server.origin}web/admin`);
  await page.getByRole("button", { name: "New library" }).first().click();
  const create = page.getByRole("dialog", { name: "New library" });
  await create.getByLabel("Folder on the server").fill(typed);
  await create.getByRole("button", { name: "Next" }).click();
  await create.getByLabel("Name").fill("Typed");
  await create.getByRole("button", { name: "Create library" }).click();
  await expect(create).toBeHidden();
  const card = page.getByRole("article").filter({ hasText: "Typed" });
  await expect(card.getByText(await realpath(typed), { exact: true })).toBeVisible();
  await card.getByRole("button", { name: /^Change / }).click();
  const change = page.getByRole("dialog", { name: "Change Typed folder" });
  await change.getByLabel("Folder on the server").fill(moved);
  await change.getByRole("button", { name: "Use this folder" }).click();
  await expect(change).toBeHidden();
  await expect(card.getByText(await realpath(moved), { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Change / })).toHaveCount(1);
  expect(unsupported).toEqual([]);
});

const withHome = test.extend<{ home: string }>({
  home: async ({ playwright: _playwright }, use) => {
    const home = await mkdtemp(join(tmpdir(), "lumen-home-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  serverEnvironment: async ({ home }, use) => {
    await use({ HOME: home, USERPROFILE: home });
  },
});

withHome(
  "administrators create a library from a folder they browse to and change its folder later",
  async ({ server, admin: _admin, home, page }) => {
    await server.media(home, "libraries/movies/Film.mp4");
    await server.media(home, "libraries/other/Other.mp4");
    await signIn(page, server);
    await page.goto(`${server.origin}web/admin`);
    await page.getByRole("button", { name: "New library" }).first().click();
    const create = page.getByRole("dialog", { name: "New library" });
    const contents = create.getByRole("list", { name: "Folder contents" });
    await expect(create.getByRole("button", { name: "Next" })).toBeDisabled();
    await contents.getByRole("button", { name: "libraries", exact: true }).click();
    await contents.getByRole("button", { name: "movies", exact: true }).click();
    await expect(contents.getByText(/^Film\.(mp4|webm)$/)).toBeVisible();
    await expect(create.getByText(/^~[\\/]libraries[\\/]movies$/)).toBeVisible();
    await create.getByRole("button", { name: "Next" }).click();
    await expect(create.getByLabel("Name")).toHaveValue("Movies");
    await create.getByRole("button", { name: "Create library" }).click();
    await expect(create).toBeHidden();

    const card = page.getByRole("article").filter({ hasText: "Movies" });
    await expect(card.getByText(/libraries[\\/]movies$/)).toBeVisible();
    await page.getByRole("button", { name: "New library" }).first().click();
    await contents.getByRole("button", { name: "libraries", exact: true }).click();
    await expect(create.getByText("Overlaps a folder in Movies")).toBeVisible();
    await expect(create.getByRole("button", { name: "Next" })).toBeDisabled();
    await create.getByRole("button", { name: "Cancel" }).click();
    await expect(create).toBeHidden();
    await expect(card.getByRole("button", { name: /^Remove / })).toBeDisabled();
    await card.getByRole("button", { name: /^Change / }).click();
    const change = page.getByRole("dialog", { name: "Change Movies folder" });
    await expect(change.getByRole("button", { name: "Use this folder" })).toBeDisabled();
    await change.getByRole("button", { name: "Up one folder" }).click();
    await change
      .getByRole("list", { name: "Folder contents" })
      .getByRole("button", { name: "other", exact: true })
      .click();
    await change.getByRole("button", { name: "Use this folder" }).click();
    await expect(change).toBeHidden();
    await expect(card.getByText(/libraries[\\/]other$/)).toBeVisible();
  },
);

for (const output of ["mp4", "webm"] as const)
  test(`incompatible container and audio transcode to ${output}, seek and close`, async ({
    server,
    admin,
    page,
  }) => {
    await requireConversion(page, output === "webm");
    const library = await server.library(admin.accessToken, "movies", []);
    const { copyFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await copyFile(
      join(import.meta.dirname, "../fixtures/playback-ac3.mkv"),
      join(library.path, "Film.mkv"),
    );
    await server.scan(admin.accessToken, library.id);
    await signIn(page, server);
    await openMovie(page, server, library.id);
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0.3);
    expect(await video.getAttribute("src")).toContain("transcode=1");
    expect(await video.getAttribute("src")).toContain(`format=${output}`);
    await pause(page);
    const info = await openPlaybackInfo(page);
    await expect(playbackInfoValue(info, "Play method")).toHaveText(/^Converting /u);
    await info.getByRole("button", { name: "Close playback info" }).click();
    await page.getByRole("button", { name: "Forward 10 seconds" }).click();
    await expect
      .poll(async () =>
        new URL((await video.getAttribute("src")) ?? "http://invalid").searchParams.get("start"),
      )
      .not.toBe("0");
    await page.mouse.move(310, 310);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(video).toHaveCount(0);
  });

for (const action of ["seek again", "pause"] as const)
  test(`converted playback preserves intent when ${action} interrupts a seek`, async ({
    server,
    admin,
    page,
  }) => {
    await requireConversion(page);
    const library = await server.library(admin.accessToken, "movies", [], {
      "Film.mkv": "playback-ac3.mkv",
    });
    await signIn(page, server);
    await openMovie(page, server, library.id);
    const video = page.locator("video");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route("**/api/v1/media/**", async (route) => {
      requests += 1;
      await gate;
      await route.continue().catch(() => {});
    });
    try {
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => requests).toBeGreaterThan(0);
      if (action === "seek again") {
        await page.keyboard.press("ArrowLeft");
        await expect.poll(() => requests).toBeGreaterThan(1);
      } else {
        await pause(page);
      }
    } finally {
      release();
    }
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    if (action === "seek again") await playing(page);
    else {
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(true);
      await page.keyboard.press("Space");
      await playing(page);
    }
  });

test.describe("native browser audio", () => {
  test.beforeEach(async ({ server, admin }) => {
    const settings = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
      token: admin.accessToken,
    });
    await server.api("/admin/transcoding-settings", {
      token: admin.accessToken,
      method: "PUT",
      body: { ...settings, enabled: false },
    });
  });
  for (const [format, artwork] of [
    ["wav", null],
    ["flac", null],
    ["opus", null],
    ["aac", null],
    ["mp3", "png"],
    ["flac", "mjpeg"],
  ] as const)
    test(`supported ${format}${artwork === null ? "" : ` with ${artwork} artwork`} plays directly with transcoding disabled`, async ({
      server,
      admin,
      page,
    }) => {
      const { execFileSync } = await import("node:child_process");
      const { join } = await import("node:path");
      const library = await server.library(admin.accessToken, "movies", []);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        join(import.meta.dirname, "../fixtures/playback.mp4"),
        ...(artwork === null
          ? ["-vn"]
          : [
              "-i",
              join(import.meta.dirname, "../fixtures/still.png"),
              "-map",
              "0:a:0",
              "-map",
              "1:v:0",
              "-c:v",
              artwork,
              "-disposition:v:0",
              "attached_pic",
            ]),
        join(library.path, `Film.${format}`),
      ]);
      await server.scan(admin.accessToken, library.id);
      if (artwork !== null) {
        const database = openDatabase(server.databasePath);
        try {
          expect(
            database.prepare("SELECT count(*) AS n FROM streams WHERE kind='video'").get(),
          ).toEqual({ n: 0 });
          const track = database.prepare("SELECT id, primary_stream_id FROM tracks").get();
          // Older scans stored cover art as video; a full rescan repairs that metadata.
          database
            .prepare(
              "INSERT INTO streams(id,source_id,kind,codec,ordinal,is_default) SELECT ?,source_id,'video',?,1,1 FROM tracks",
            )
            .run(crypto.randomUUID(), artwork);
          await server.scan(admin.accessToken, library.id, "full");
          expect(
            database.prepare("SELECT count(*) AS n FROM streams WHERE kind='video'").get(),
          ).toEqual({ n: 0 });
          expect(database.prepare("SELECT id, primary_stream_id FROM tracks").get()).toEqual(track);
        } finally {
          database.close();
        }
      }
      const conversions: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).searchParams.get("transcode") === "1")
          conversions.push(request.url());
      });
      await signIn(page, server);
      await openMovie(page, server, library.id);
      expect(await page.locator("video").getAttribute("src")).not.toContain("transcode=1");
      expect(conversions).toEqual([]);
    });
});

test.describe(() => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Throttles the link through the Chromium protocol",
  );

  test("auto quality steps down on a slow link and back up without stalling once it recovers", async ({
    server,
    admin,
    page,
  }) => {
    const [library] = await Promise.all([
      server.library(admin.accessToken, "movies", []).then(async (library) => {
        // MPEG-4 Part 2 needs its video converted, so Auto plays converted pieces from the start.
        await promisify(execFile)("ffmpeg", [
          ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
          ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "40"],
          ...["-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac"],
          join(library.path, "Film.mkv"),
        ]);
        await server.scan(admin.accessToken, library.id);
        return library;
      }),
      signIn(page, server),
    ]);
    const pieces: string[] = [];
    page.on("request", (request) => {
      const match = /\/adaptive\/\d+\/(\d+p)\/\d+\.ts/u.exec(request.url());
      if (match?.[1] !== undefined) pieces.push(match[1]);
    });
    const network = await page.context().newCDPSession(page);
    // Only media is slowed: the page's own scripts arriving late is not what Auto answers to.
    const throttle = (bytesPerSecond: number) =>
      network.send("Network.emulateNetworkConditionsByRule", {
        matchedNetworkConditions: [
          {
            urlPattern: `${new URL(server.origin).origin}/api/v1/media/*`,
            latency: 0,
            downloadThroughput: bytesPerSecond,
            uploadThroughput: -1,
          },
        ],
      });
    await network.send("Network.enable");
    await throttle(250_000);
    await openMovie(page, server, library.id);
    const video = page.locator("video");
    expect(await video.getAttribute("src")).toMatch(/^blob:/u);

    const quality = async () => {
      await page.mouse.move(300, 300);
      const settings = page.getByRole("button", { name: "Playback settings" });
      if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
      return (await page.locator(".media-player-quality-value").textContent()) ?? "";
    };
    await expect.poll(() => pieces.includes("360p")).toBe(true);
    await expect.poll(quality).toBe("Auto (360p)");
    const info = await openPlaybackInfo(page);
    await expect(playbackInfoValue(info, "Play method")).toHaveText("Converting (360p)");
    await expect(playbackInfoValue(info, "Protocol")).toHaveText("HLS over http");
    await expect(playbackInfoValue(info, "Quality")).toHaveText("Auto (360p)");
    await expect(playbackInfoValue(info, "Network speed")).toHaveText(/bps$/u);
    await info.getByRole("button", { name: "Close playback info" }).click();

    await throttle(-1);
    const stalls = await video.evaluate((element: HTMLVideoElement) => {
      const seen = { count: 0 };
      element.addEventListener("waiting", () => {
        if (!element.seeking) seen.count += 1;
      });
      (window as unknown as { stalls: typeof seen }).stalls = seen;
      return seen.count;
    });
    expect(stalls).toBe(0);
    // A step up keeps the next 8 s already held, so 720p reaches the screen only after that much
    // playback: wait for the picture itself rather than racing playback against a poll.
    await video.evaluate(
      (element: HTMLVideoElement) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (element.videoHeight !== 720) return;
            element.removeEventListener("resize", check);
            resolve();
          };
          element.addEventListener("resize", check);
          check();
        }),
    );
    await expect.poll(quality).toBe("Auto (720p)");
    expect(
      await page.evaluate(() => (window as unknown as { stalls: { count: number } }).stalls.count),
    ).toBe(0);

    // A manual choice takes over from Auto and closes the menu. A lower one keeps the better
    // pieces already held, so it changes what is fetched next rather than what is on screen.
    // Original cannot play in the browser for MPEG-4 video, so it is omitted from the menu.
    await page.locator(".media-player-quality-row").click();
    await expect(page.getByRole("menuitemradio", { name: /^Original/u })).toHaveCount(0);
    const saved = page.waitForResponse((response) => response.url().endsWith("/track-choice"));
    await page.getByRole("menuitemradio", { name: /^480p/u }).click();
    await expect(page.getByRole("menu", { name: "Quality" })).toBeHidden();
    await expect.poll(quality).toBe("480p");
    expect((await saved).ok()).toBe(true);

    // The title remembers it: playing it again starts there instead of at Auto.
    await openMovie(page, server, library.id);
    await expect.poll(quality).toBe("480p");
  });
});

test("Auto adapts among converted pieces only, leaving the original and staying off it through a seek", async ({
  server,
  admin,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Plays H.264 pieces through MediaSource");
  const library = await server.library(admin.accessToken, "movies", []);
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "40"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"],
    join(library.path, "Film.mkv"),
  ]);
  await server.scan(admin.accessToken, library.id);
  await signIn(page, server);
  await openMovie(page, server, library.id);
  const video = page.locator("video");
  const source = () => video.getAttribute("src");
  expect(await source()).not.toMatch(/^blob:/u);

  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Playback settings" }).click();
  await page.locator(".media-player-quality-row").click();
  await page.getByRole("menuitemradio", { name: /^Auto/u }).click();
  await expect.poll(source).toMatch(/^blob:/u);
  await playing(page);

  // A local link has room for the original, and a seek still lands on converted pieces.
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThanOrEqual(10);
  await playing(page);
  expect(await source()).toMatch(/^blob:/u);

  // Switching back to Original clears the Auto override; turning transcoding off then removes the
  // unselectable converted qualities even when playback starts directly on the original.
  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Playback settings" }).click();
  await page.locator(".media-player-quality-row").click();
  const reset = page.waitForResponse((response) => response.url().endsWith("/track-choice"));
  await page.getByRole("menuitemradio", { name: /^Original/u }).click();
  expect((await reset).ok()).toBe(true);

  const transcoding = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
    token: admin.accessToken,
  });
  await server.api("/admin/transcoding-settings", {
    token: admin.accessToken,
    method: "PUT",
    body: { ...transcoding, enabled: false },
  });
  await openMovie(page, server, library.id);
  expect(await source()).not.toMatch(/^blob:/u);
  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Playback settings" }).click();
  await expect(page.locator(".media-player-quality-value")).toHaveText("Original");
  await page.locator(".media-player-quality-row").click();
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(/^Original/u);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
});

test("a rejected copied video retries with actual encoding", async ({ server, admin, page }) => {
  await requireConversion(page);
  const library = await server.library(admin.accessToken, "movies", [], {
    "Film.mkv": "playback-ac3.mkv",
  });
  await page.route("**/api/v1/media/**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("video") === "copy")
      await route.fulfill({ contentType: "video/mp4", body: "unsupported copied video" });
    else await route.continue();
  });
  await signIn(page, server);
  await openMovie(page, server, library.id);
  expect(await page.locator("video").getAttribute("src")).toContain("video=h264");
});

test("administrators configure transcoding from Settings and persist changes", async ({
  server,
  admin: _admin,
  page,
}, testInfo) => {
  await signIn(page, server);
  const panel = await openSettings(page, "Transcoding");
  await expect(panel.getByRole("switch", { name: /^Enable transcoding/ })).toBeChecked();
  await panel.getByLabel("CPU threads per job", { exact: true }).fill("3");
  let finishSave = () => {};
  const saveGate = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  await page.route("**/api/v1/admin/transcoding-settings", async (route) => {
    const response = await route.fetch();
    await saveGate;
    await route.fulfill({ response });
  });
  await panel.getByRole("button", { name: "Save transcoding settings" }).click();
  try {
    await expect(panel.getByRole("switch", { name: /^Enable transcoding/ })).toBeDisabled();
    await expect(
      panel.getByRole("switch", { name: /^Allow software video encoding/ }),
    ).toBeDisabled();
  } finally {
    finishSave();
  }

  await expect(panel.getByRole("status")).toHaveText("Transcoding settings saved.");
  await page.unroute("**/api/v1/admin/transcoding-settings");
  await page.reload();
  await openSettings(page, "Transcoding");
  await expect(panel.getByLabel("CPU threads per job", { exact: true })).toHaveValue("3");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("CPU transcoding settings", {
    body: await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("transcoding-cpu.png"),
    }),
    contentType: "image/png",
  });
  await panel.getByRole("combobox", { name: "Video encoder" }).click();
  await page.getByRole("option", { name: "NVIDIA NVENC", exact: true }).click();
  await panel.getByLabel("GPU devices", { exact: true }).fill("0,1");
  await panel.getByLabel("Maximum jobs per GPU", { exact: true }).fill("3");
  await panel.getByRole("button", { name: "Save transcoding settings" }).click();
  await expect(panel.getByRole("status")).toHaveText("Transcoding settings saved.");
  await page.reload();
  await openSettings(page, "Transcoding");
  await expect(panel.getByLabel("GPU devices", { exact: true })).toHaveValue("0,1");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("Multi-GPU transcoding settings", {
    body: await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("transcoding-gpu.png"),
    }),
    contentType: "image/png",
  });
  await panel.getByRole("switch", { name: /^Enable transcoding/ }).click();
  await panel.getByRole("button", { name: "Save transcoding settings" }).click();
  await expect(panel.getByRole("status")).toHaveText("Transcoding settings saved.");
  await page.reload();
  await openSettings(page, "Transcoding");
  await expect(panel.getByRole("switch", { name: /^Enable transcoding/ })).not.toBeChecked();
});
