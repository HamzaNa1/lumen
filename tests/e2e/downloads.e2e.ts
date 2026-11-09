import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { DownloadEntry, DownloadState } from "../../packages/contracts/src/downloads";
import { connectDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";
import { NetworkProxy } from "./support/proxy";
import { password, repository, type Server } from "./support/server";

// Small chunks and segments make a few megabytes span many of each.
const CHUNK = 64 * 1024;
const SEGMENT = 256 * 1024;
const diskFile = join(tmpdir(), `lumen-e2e-disk-${randomUUID()}.json`);
test.use({
  desktopEnvironment: {
    LUMEN_E2E_MEDIA_CHUNK_BYTES: String(CHUNK),
    LUMEN_E2E_MEDIA_SEGMENT_BYTES: String(SEGMENT),
    LUMEN_E2E_DISK_FILE: diskFile,
  },
});
test.beforeEach(async () => {
  await writeFile(diskFile, JSON.stringify({ totalBytes: 1e12, freeBytes: 5e11 }));
});
test.afterAll(async () => {
  await rm(diskFile, { force: true });
});

/** A 30-second film with its index at the end, as a player finds it in many real files. */
const makeFilm = (path: string, seconds = 30, tone = 440) =>
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${seconds}:size=640x360:rate=24`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${tone}:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "800k",
    "-c:a",
    "aac",
    path,
  ]);

const movies = async (server: Server, token: string, titles: readonly string[]) => {
  const library = await server.library(token, "movies", []);
  for (const [index, title] of titles.entries())
    makeFilm(join(library.path, `${title}.mp4`), 30, 300 + index * 100);
  await server.scan(token, library.id);
  const items = await server.items(token, library.id);
  return {
    library,
    item: (title: string) => {
      const item = items.find((entry) => entry.title === title);
      if (item === undefined) throw new Error(`${title} was not scanned`);
      return { ...item, path: join(library.path, `${title}.mp4`) };
    },
  };
};

const downloads = (page: Page): Promise<DownloadState> =>
  page.evaluate(() => window.lumen.downloads.state());
const entryFor = async (page: Page, itemId: string): Promise<DownloadEntry | undefined> =>
  (await downloads(page)).entries.find((entry) => entry.itemId === itemId);

/** Every directory holding a file's bytes, and the bytes they hold, in order. */
const heldFiles = async (profile: string) => {
  const root = join(profile, "media");
  const found: { directory: string; bytes: Buffer }[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const segments = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("seg-"))
      .map((entry) => entry.name)
      .sort();
    if (entries.some((entry) => entry.name === "index.json"))
      found.push({
        directory,
        bytes: Buffer.concat(
          await Promise.all(segments.map((name) => readFile(join(directory, name)))),
        ),
      });
    for (const entry of entries) if (entry.isDirectory()) await walk(join(directory, entry.name));
  };
  await walk(root);
  return found;
};

/**
 * Every chunk a file's index records as held, with the bytes stored for it. Segment files can
 * have gaps; only what the index marks is ever served.
 */
const heldChunks = async (profile: string) => {
  const found: { offset: number; bytes: Buffer }[] = [];
  for (const { directory } of await heldFiles(profile)) {
    const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8")) as {
      chunks: string;
      spec: { sizeBytes: number };
    };
    const bits = Buffer.from(index.chunks, "base64");
    for (let chunk = 0; chunk * CHUNK < index.spec.sizeBytes; chunk += 1) {
      if (((bits[chunk >> 3] ?? 0) & (1 << (chunk & 7))) === 0) continue;
      const offset = chunk * CHUNK;
      const segment = Math.floor(offset / SEGMENT);
      const stored = await readFile(join(directory, `seg-${String(segment).padStart(6, "0")}.bin`));
      const within = offset - segment * SEGMENT;
      const length = Math.min(CHUNK, index.spec.sizeBytes - offset);
      found.push({ offset, bytes: stored.subarray(within, within + length) });
    }
  }
  return found;
};

const playFromDownloads = async (page: Page, title: string) => {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Downloads" })
    .click();
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()), { timeout: 30_000 })
    .toMatchObject({ paused: false });
};

const go = (page: Page, route: string) =>
  page.evaluate((route) => {
    location.hash = route;
  }, route);

const openSettings = async (page: Page) => {
  await go(page, "/settings");
  await expect(page.getByRole("heading", { name: "Downloads and storage" })).toBeVisible();
};

const leavePlayer = async (page: Page) => {
  await page.evaluate(() => window.lumen.player.stop());
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
};

/**
 * Media passes through only up to an allowance of bytes the test raises, so a download can be
 * held part way without depending on timing.
 */
const meter = (proxy: NetworkProxy, upstream: () => string) => {
  const waiting = new Set<() => void>();
  const active = new Set<ServerResponse>();
  const wakeAll = () => {
    for (const wake of waiting) wake();
    waiting.clear();
  };
  const control = {
    sent: 0,
    allowance: Number.POSITIVE_INFINITY,
    ranges: [] as number[],
    /** Answers media requests as an overloaded server would. */
    failing: false,
    /** Holds back media for paths it matches until it no longer does. */
    blocked: (_path: string): boolean => false,
    allow(bytes: number) {
      control.allowance = Math.floor(bytes);
      wakeAll();
    },
    block(predicate: (path: string) => boolean) {
      control.blocked = predicate;
      wakeAll();
    },
    /** Cuts every media transfer in progress, as a dropped connection does. */
    breakAll() {
      for (const response of active) response.destroy();
    },
  };
  proxy.intercept = async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url?.startsWith("/api/v1/media/")) return false;
    const path = request.url;
    if (control.failing) {
      response.writeHead(503).end();
      return true;
    }
    active.add(response);
    response.on("close", () => active.delete(response));
    control.ranges.push(Number(/bytes=(\d+)-/u.exec(request.headers.range ?? "")?.[1] ?? 0));
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      const remote = await fetch(new URL(request.url, upstream()), {
        headers: {
          authorization: request.headers.authorization ?? "",
          ...(request.headers.range === undefined ? {} : { range: request.headers.range }),
        },
        signal: abort.signal,
      });
      response.writeHead(remote.status, Object.fromEntries(remote.headers));
      const reader = remote.body?.getReader();
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        for (let offset = 0; offset < chunk.value.length; ) {
          while (
            (control.sent >= control.allowance || control.blocked(path)) &&
            !response.destroyed
          )
            await new Promise<void>((resolve) => {
              waiting.add(resolve);
              response.once("close", () => resolve());
            });
          if (response.destroyed) return true;
          const piece = chunk.value.subarray(
            offset,
            offset + Math.min(16 * 1024, control.allowance - control.sent),
          );
          response.write(piece);
          control.sent += piece.length;
          offset += piece.length;
        }
      }
      response.end();
    } catch {
      response.destroy();
    }
    return true;
  };
  return control;
};

test("a download keeps the exact file, plays with the server gone, and saves that progress when it returns", async ({
  server,
  admin,
  desktop,
}) => {
  const { item } = await movies(server, admin.accessToken, ["Film"]);
  const film = item("Film");
  let proxy = await new NetworkProxy(server.origin).start();
  const port = Number(new URL(proxy.origin).port);
  const { page, profile } = desktop;
  await connectDesktop(page, proxy);
  await go(page, `/item/${film.id}`);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect
    .poll(async () => (await entryFor(page, film.id))?.status, { timeout: 60_000 })
    .toBe("completed");
  await expect(page.getByRole("button", { name: /^Downloaded\. Download options/ })).toBeVisible();
  const [held] = await heldFiles(profile);
  expect(held?.bytes.equals(await readFile(film.path))).toBe(true);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Downloads" })
    .click();
  await expect(page.getByRole("listitem", { name: "Film" })).toContainText("Downloaded");

  // The server goes away entirely, and the app starts without it.
  await desktop.app.close();
  await proxy.close();
  const reopened = await launchDesktop(profile, false, {
    LUMEN_E2E_MEDIA_CHUNK_BYTES: String(CHUNK),
    LUMEN_E2E_MEDIA_SEGMENT_BYTES: String(SEGMENT),
    LUMEN_E2E_DISK_FILE: diskFile,
  });
  try {
    const offline = await mainDesktopPage(reopened);
    await expect(offline.getByRole("status").filter({ hasText: "Can’t reach" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(offline.getByRole("listitem", { name: "Film" })).toBeVisible();
    await playFromDownloads(offline, "Film");
    await expect
      .poll(
        async () => (await offline.evaluate(() => window.lumen.player.state()))?.positionSeconds,
      )
      .toBeGreaterThan(1);
    const state = await offline.evaluate(() => window.lumen.player.state());
    await offline.evaluate(
      ({ sessionId, position }) => window.lumen.player.seek(sessionId, position),
      { sessionId: state?.sessionId ?? "", position: (state?.durationSeconds ?? 30) - 1 },
    );
    await expect
      .poll(() => offline.evaluate(() => window.lumen.player.state()), { timeout: 20_000 })
      .toMatchObject({ ended: true });
    await expect
      .poll(async () => (await entryFor(offline, film.id))?.watchedAtMs ?? null)
      .not.toBeNull();
    await leavePlayer(offline);

    // The server is back where the app left it: the progress made offline reaches it.
    proxy = await new NetworkProxy(server.origin).start(port);
    expect(
      (
        await server.api<{ watchState: { completed: boolean } | null }>(`/items/${film.id}`, {
          token: admin.accessToken,
        })
      ).watchState?.completed ?? false,
    ).toBe(false);
    await offline.getByRole("button", { name: "Try again" }).click();
    await expect(offline.getByRole("status").filter({ hasText: "Can’t reach" })).toBeHidden();
    await expect
      .poll(
        async () =>
          (
            await server.api<{ watchState: { completed: boolean } | null }>(`/items/${film.id}`, {
              token: admin.accessToken,
            })
          ).watchState?.completed,
      )
      .toBe(true);
  } finally {
    await reopened.close();
    await proxy.close();
  }
});

test("playback crosses from downloaded parts into missing ones and keeps the download going", async ({
  server,
  admin,
  desktop,
}) => {
  const { item } = await movies(server, admin.accessToken, ["Film"]);
  const film = item("Film");
  const size = (await readFile(film.path)).length;
  const proxy = await new NetworkProxy(server.origin).start();
  const network = meter(proxy, () => server.origin);
  network.allow(size * 0.35);
  const { page, profile } = desktop;
  try {
    await connectDesktop(page, proxy);
    await page.evaluate((itemId) => window.lumen.downloads.add([itemId]), film.id);
    await expect
      .poll(async () => (await entryFor(page, film.id))?.downloadedBytes ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(size * 0.2);
    const paused = await entryFor(page, film.id);
    await page.evaluate((id) => window.lumen.downloads.pause(id), paused?.id ?? "");
    await expect.poll(async () => (await entryFor(page, film.id))?.status).toBe("paused");
    const heldBefore = (await entryFor(page, film.id))?.downloadedBytes ?? 0;
    expect(heldBefore).toBeLessThan(size * 0.4);
    const fetchedBefore = network.ranges.length;
    network.allow(Number.POSITIVE_INFINITY);

    // Playback reads what is held, then waits on the network where the download stopped.
    await playFromDownloads(page, "Film");
    const boundary = (heldBefore / size) * 30;
    await expect
      .poll(
        async () => (await page.evaluate(() => window.lumen.player.state()))?.positionSeconds ?? 0,
        {
          timeout: 45_000,
        },
      )
      .toBeGreaterThan(boundary + 2);
    // Bytes fetched for playback are kept: the paused download still grows.
    expect((await entryFor(page, film.id))?.downloadedBytes ?? 0).toBeGreaterThan(heldBefore);
    expect(network.ranges.slice(fetchedBefore).some((start) => start > 0)).toBe(true);
    const playing = await page.evaluate(() => window.lumen.player.state());
    expect(playing?.downloadedRanges?.length ?? 0).toBeGreaterThan(0);
    expect(playing?.paused).toBe(false);

    // A seek far into what is missing plays from there.
    await page.evaluate(
      (sessionId) => window.lumen.player.seek(sessionId, 24),
      playing?.sessionId ?? "",
    );
    await expect
      .poll(
        async () => (await page.evaluate(() => window.lumen.player.state()))?.positionSeconds ?? 0,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(25);

    // Resuming fills the rest while the item plays on.
    await page.evaluate((id) => window.lumen.downloads.resume(id), paused?.id ?? "");
    await expect
      .poll(async () => (await entryFor(page, film.id))?.status, { timeout: 60_000 })
      .toBe("completed");
    await leavePlayer(page);
    const [held] = await heldFiles(profile);
    expect(held?.bytes.equals(await readFile(film.path))).toBe(true);
  } finally {
    await proxy.close();
  }
});

test("the free-space limit pauses downloads but never playback, and cleanup rules remove watched downloads", async ({
  server,
  admin,
  desktop,
}) => {
  const { item } = await movies(server, admin.accessToken, ["Film", "Other"]);
  const film = item("Film");
  const other = item("Other");
  // A 100 MB disk with the 10% limit two segments away.
  await writeFile(diskFile, JSON.stringify({ totalBytes: 100e6, freeBytes: 10e6 + 2.5 * SEGMENT }));
  const { page, profile } = desktop;
  await connectDesktop(page, server);
  await page.evaluate((itemId) => window.lumen.downloads.add([itemId]), film.id);
  await expect
    .poll(async () => await entryFor(page, film.id), { timeout: 30_000 })
    .toMatchObject({ status: "waiting", reason: "Paused: disk almost full" });
  const stalled = (await entryFor(page, film.id))?.downloadedBytes ?? 0;
  expect(stalled).toBeLessThan((await readFile(film.path)).length);

  // Playback carries on past what fits on the disk.
  await playFromDownloads(page, "Film");
  await expect
    .poll(
      async () => (await page.evaluate(() => window.lumen.player.state()))?.positionSeconds ?? 0,
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(8);
  await leavePlayer(page);

  // Lowering the limit in Settings lets the download finish.
  await openSettings(page);
  await expect(page.getByText("10% of 100 MB: downloads pause at 10.0 MB free")).toBeVisible();
  const percent = page.getByRole("spinbutton", { name: "Free space limit percent" });
  await percent.fill("5");
  await percent.press("Enter");
  await expect
    .poll(async () => (await entryFor(page, film.id))?.status, { timeout: 60_000 })
    .toBe("completed");
  expect((await downloads(page)).settings.minimumFreeSpacePercent).toBe(5);
  await writeFile(diskFile, JSON.stringify({ totalBytes: 1e12, freeBytes: 5e11 }));

  // Watched downloads go as soon as the rule says, unless the viewer keeps them.
  await page.getByRole("combobox", { name: "Delete watched downloads" }).click();
  await page.getByRole("option", { name: "Right after watching" }).click();
  await expect
    .poll(async () => (await downloads(page)).settings.deleteWatchedAfter)
    .toBe("immediately");
  await page.evaluate((itemId) => window.lumen.downloads.add([itemId]), other.id);
  await expect
    .poll(async () => (await entryFor(page, other.id))?.status, { timeout: 60_000 })
    .toBe("completed");
  const kept = await entryFor(page, other.id);
  await page.evaluate((id) => window.lumen.downloads.keep(id, true), kept?.id ?? "");
  for (const title of ["Film", "Other"]) {
    await playFromDownloads(page, title);
    const state = await page.evaluate(() => window.lumen.player.state());
    await page.evaluate(
      ({ sessionId, position }) => window.lumen.player.seek(sessionId, position),
      { sessionId: state?.sessionId ?? "", position: (state?.durationSeconds ?? 30) - 1 },
    );
    await expect
      .poll(() => page.evaluate(() => window.lumen.player.state()), { timeout: 20_000 })
      .toMatchObject({ ended: true });
    await leavePlayer(page);
  }
  await expect.poll(async () => await entryFor(page, film.id), { timeout: 20_000 }).toBeUndefined();
  expect(await entryFor(page, other.id)).toMatchObject({
    keep: true,
    watchedAtMs: expect.any(Number),
  });
  expect(await heldFiles(profile)).toHaveLength(1);
});

test("the streaming cache keeps nothing by default, keeps recent streams within its size, and clears", async ({
  server,
  admin,
  desktop,
}) => {
  const { item } = await movies(server, admin.accessToken, ["Film"]);
  const film = item("Film");
  const { page, profile } = desktop;
  await connectDesktop(page, server);
  const stream = async () => {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "movies" })
      .click();
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    await expect
      .poll(
        async () => (await page.evaluate(() => window.lumen.player.state()))?.positionSeconds ?? 0,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(3);
    await leavePlayer(page);
  };
  await stream();
  expect(await heldFiles(profile)).toEqual([]);
  expect((await downloads(page)).usage.cacheBytes).toBe(0);

  await openSettings(page);
  await page.getByRole("combobox", { name: "Streaming cache" }).click();
  await page.getByRole("option", { name: "Low (0.5 GB)" }).click();
  await expect.poll(async () => (await downloads(page)).settings.streamingCache).toBe("low");
  await stream();
  await expect.poll(async () => (await downloads(page)).usage.cacheBytes).toBeGreaterThan(0);
  // Every chunk kept holds exactly the bytes at its place in the file, head and tail alike.
  const original = await readFile(film.path);
  await expect.poll(async () => (await heldChunks(profile)).length).toBeGreaterThan(0);
  for (const { offset, bytes } of await heldChunks(profile))
    expect(bytes.equals(original.subarray(offset, offset + bytes.length))).toBe(true);
  expect(await entryFor(page, film.id)).toBeUndefined();

  await openSettings(page);
  await page.getByRole("button", { name: /^Clear / }).click();
  await expect.poll(async () => (await downloads(page)).usage.cacheBytes).toBe(0);
  expect(await heldFiles(profile)).toEqual([]);
});

test("changed files are replaced, revoked downloads are deleted, and signing out removes everything", async ({
  server,
  admin,
  desktop,
}) => {
  const first = await movies(server, admin.accessToken, ["Film"]);
  const second = await movies(server, admin.accessToken, ["Other"]);
  const film = first.item("Film");
  const other = second.item("Other");
  const viewer = await server.api<{ id: string }>("/users", {
    token: admin.accessToken,
    body: {
      username: "viewer",
      displayName: "Viewer",
      password,
      libraryAccess: { scope: "selected", libraryIds: [first.library.id, second.library.id] },
    },
  });
  const { page, profile } = desktop;
  await connectDesktop(page, server, "viewer");
  await page.evaluate((ids) => window.lumen.downloads.add(ids), [film.id, other.id]);
  for (const itemId of [film.id, other.id])
    await expect
      .poll(async () => (await entryFor(page, itemId))?.status, { timeout: 60_000 })
      .toBe("completed");
  expect(await heldFiles(profile)).toHaveLength(2);

  // The film is re-encoded on the server and the viewer loses the other library.
  makeFilm(join(first.library.path, "Replacement.mp4"), 20, 900);
  await rm(film.path);
  execFileSync("cp", [join(first.library.path, "Replacement.mp4"), film.path]);
  await rm(join(first.library.path, "Replacement.mp4"));
  const later = new Date(Date.now() + 120_000);
  await utimes(film.path, later, later);
  await server.scan(admin.accessToken, first.library.id);
  await server.api(`/users/${viewer.id}`, {
    token: admin.accessToken,
    method: "PATCH",
    status: 200,
    body: { libraryAccess: { scope: "selected", libraryIds: [first.library.id] } },
  });
  const connectionId = (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId;
  await page.evaluate((id) => window.lumen.accounts.activate(id), connectionId ?? "");
  await expect
    .poll(async () => await entryFor(page, other.id), { timeout: 30_000 })
    .toBeUndefined();
  await expect
    .poll(
      async () => {
        const files = await heldFiles(profile);
        return files.length === 1 && files[0]?.bytes.equals(await readFile(film.path));
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(await entryFor(page, film.id)).toMatchObject({ status: "completed" });

  await page.evaluate((id) => window.lumen.accounts.remove(id), connectionId ?? "");
  await expect.poll(async () => (await downloads(page)).entries).toEqual([]);
  expect(await heldFiles(profile)).toEqual([]);
});

test("a show keeps its next unwatched episode downloaded as episodes are watched", async ({
  server,
  admin,
  desktop,
}) => {
  const library = await server.library(admin.accessToken, "shows", [
    "Show/Season 1/Show S01E01.mp4",
    "Show/Season 1/Show S01E02.mp4",
    "Show/Season 1/Show S01E03.mp4",
  ]);
  const items = await server.items(admin.accessToken, library.id);
  const show = items.find((entry) => entry.kind === "show");
  const { page } = desktop;
  await connectDesktop(page, server);
  await page.evaluate(() =>
    window.lumen.downloads.updateSettings({ deleteWatchedAfter: "immediately" }),
  );
  await go(page, `/show/${show?.id}`);
  await page.getByRole("button", { name: "Auto-download", exact: true }).click();
  await page.getByRole("menuitem", { name: "Next episode" }).click();
  await expect(page.getByRole("button", { name: "Auto-download: Next episode" })).toBeVisible();
  const autoEpisodes = async () =>
    (await downloads(page)).entries
      .filter((entry) => entry.autoShowId === show?.id)
      .map((entry) => `${entry.item.title}:${entry.status}`);
  await expect.poll(autoEpisodes, { timeout: 30_000 }).toEqual(["Episode 1:completed"]);

  await playFromDownloads(page, "Episode 1");
  const state = await page.evaluate(() => window.lumen.player.state());
  await page.evaluate(({ sessionId, position }) => window.lumen.player.seek(sessionId, position), {
    sessionId: state?.sessionId ?? "",
    position: (state?.durationSeconds ?? 20) - 0.5,
  });
  // The next episode is fetched once this one is watched, and the watched one goes.
  await expect.poll(autoEpisodes, { timeout: 45_000 }).toEqual(["Episode 2:completed"]);
  await leavePlayer(page);
  await page.evaluate(
    (showId) => window.lumen.downloads.showRule({ id: showId, title: "Show" }, null),
    show?.id ?? "",
  );
  await expect.poll(async () => (await downloads(page)).entries).toEqual([]);
});

test("downloads retry an unreachable server, follow a file that changes mid-download, and give way to what is watched", async ({
  server,
  admin,
  desktop,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", []);
  await mkdir(join(library.path, "Film"));
  const filmPath = join(library.path, "Film", "Film.mp4");
  makeFilm(filmPath, 30, 440);
  await copyFile(
    join(repository, "tests/fixtures/still.png"),
    join(library.path, "Film", "poster.png"),
  );
  for (const [title, tone] of [
    ["Other", 520],
    ["Third", 600],
  ] as const)
    makeFilm(join(library.path, `${title}.mp4`), 30, tone);
  await server.scan(token, library.id);
  const items = await server.items(token, library.id);
  const id = (title: string) => items.find((item) => item.title === title)?.id ?? "";
  // The file a media request names, to hold back one download while others pass.
  const otherStream = (await server.play(token, id("Other"))).streamUrl;
  const size = (await readFile(filmPath)).length;
  let proxy = await new NetworkProxy(server.origin).start();
  const network = meter(proxy, () => server.origin);
  const { page, profile } = desktop;
  try {
    await connectDesktop(page, proxy);
    network.allow(size * 0.3);
    await page.evaluate((itemId) => window.lumen.downloads.add([itemId]), id("Film"));
    await expect
      .poll(async () => (await entryFor(page, id("Film")))?.downloadedBytes ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(size * 0.15);

    // The server stops answering: the download waits and retries.
    network.failing = true;
    network.breakAll();
    await expect
      .poll(async () => await entryFor(page, id("Film")), { timeout: 30_000 })
      .toMatchObject({ status: "waiting", reason: "Can’t reach the server. Retrying…" });

    // Meanwhile the file is replaced. The bytes already held belong to the old file and go.
    makeFilm(join(library.path, "Film", "New.mp4"), 24, 700);
    await rm(filmPath);
    await copyFile(join(library.path, "Film", "New.mp4"), filmPath);
    await rm(join(library.path, "Film", "New.mp4"));
    const later = new Date(Date.now() + 120_000);
    await utimes(filmPath, later, later);
    await server.scan(token, library.id);
    network.failing = false;
    network.allow(Number.POSITIVE_INFINITY);
    await expect
      .poll(async () => (await entryFor(page, id("Film")))?.status, { timeout: 60_000 })
      .toBe("completed");
    const held = await heldFiles(profile);
    expect(held).toHaveLength(1);
    expect(held[0]?.bytes.equals(await readFile(filmPath))).toBe(true);
    await go(page, "/downloads");
    await expect(page.getByRole("listitem", { name: "Film" }).locator("img")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );

    // One download at a time: the other waits its turn until the viewer starts watching it.
    network.block((path) => path.startsWith(otherStream));
    await page.evaluate((ids) => window.lumen.downloads.add(ids), [id("Other"), id("Third")]);
    await expect.poll(async () => (await entryFor(page, id("Other")))?.status).toBe("downloading");
    expect((await entryFor(page, id("Third")))?.status).toBe("queued");
    await page.evaluate((ids) => window.lumen.downloads.add(ids), [id("Third")]);
    expect((await downloads(page)).entries).toHaveLength(3);
    await playFromDownloads(page, "Third");
    await expect
      .poll(async () => (await entryFor(page, id("Third")))?.status, { timeout: 60_000 })
      .toBe("completed");
    await leavePlayer(page);
    // Back to the one that gave way; removing it mid-download stops it and frees its space.
    await expect.poll(async () => (await entryFor(page, id("Other")))?.status).toBe("downloading");
    const other = await entryFor(page, id("Other"));
    await page.evaluate((entryId) => window.lumen.downloads.remove(entryId), other?.id ?? "");
    await expect.poll(async () => await entryFor(page, id("Other"))).toBeUndefined();
    await expect.poll(async () => (await heldFiles(profile)).length).toBe(2);

    // The server vanishes while the app is open: a download still plays.
    await proxy.close();
    await playFromDownloads(page, "Film");
    await expect
      .poll(
        async () => (await page.evaluate(() => window.lumen.player.state()))?.positionSeconds ?? 0,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(2);
    await leavePlayer(page);
    proxy = await new NetworkProxy(server.origin).start();
  } finally {
    await proxy.close();
  }
});
