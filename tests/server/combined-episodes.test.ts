import { Database as SqliteDatabase } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { type RunningServer, startServer } from "../../apps/server/src/Runtime";
import type { CatalogItem, HomeContent } from "../../packages/contracts/src/index.ts";
import { Effect } from "../../packages/database/node_modules/effect/dist/index.js";
import { Database, sql } from "../../packages/database/src/index.ts";
import { eventually } from "../helpers/eventually";

// A synthetic video under release-style names, scanned by the actual server. Its ffprobe is a stub
// printing what ffprobe reports for this fixture, so the test needs no ffmpeg install while the
// server still spawns, reads and parses a probe.
const video = join(import.meta.dir, "../fixtures/playback-ac3.mkv");
const probeOutput = {
  format: { duration: "20.000000" },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 640,
      height: 360,
      disposition: { default: 1 },
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "ac3",
      channels: 6,
      sample_rate: "48000",
      disposition: { default: 0 },
    },
  ],
};
const ffprobePath = process.env.LUMEN_FFPROBE_PATH;
const season = "The Office (2005)/Season 3";
const files = {
  before: "The.Office.US.S03E09.1080p.AMZN.WEB.x264-MRSK.mkv",
  combined: "The.Office.US.S03E10-11.1080p.AMZN.WEB.x264-MRSK.mkv",
  // A second copy of an episode the combined file already holds.
  overlap: "The.Office.US.S03E11.720p.WEB.x264-OTHER.mkv",
  after: "The.Office.US.S03E12.1080p.AMZN.WEB.x264-MRSK.mkv",
};

const servers: RunningServer[] = [];
const paths: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  if (ffprobePath === undefined) delete process.env.LUMEN_FFPROBE_PATH;
  else process.env.LUMEN_FFPROBE_PATH = ffprobePath;
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const library = async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-combined-episodes-"));
  paths.push(root);
  const media = join(root, "shows");
  await mkdir(join(media, season), { recursive: true });
  for (const file of Object.values(files)) await copyFile(video, join(media, season, file));
  const ffprobe = join(root, "ffprobe");
  await writeFile(ffprobe, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(probeOutput)}\nJSON\n`);
  await chmod(ffprobe, 0o755);
  process.env.LUMEN_FFPROBE_PATH = ffprobe;
  const databasePath = join(root, "catalog.sqlite");
  const libraryId = newUuid();
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const password = yield* Effect.promise(() => hashPassword("combined-episodes-password"));
      yield* db.run(
        sql`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,is_active,created_at_ms,updated_at_ms) VALUES(${newUuid()},'admin','admin','Admin',${password},'admin',1,1,1)`,
      );
      yield* db.run(
        sql`INSERT INTO libraries(id,name,slug,is_enabled,created_at_ms,updated_at_ms) VALUES(${libraryId},'Shows','shows',1,1,1)`,
      );
      yield* db.run(
        sql`INSERT INTO library_profiles(library_id,kind,scan_mode) VALUES(${libraryId},'shows','full')`,
      );
      yield* db.run(
        sql`INSERT INTO library_roots(id,library_id,path,is_enabled,priority,created_at_ms,updated_at_ms) VALUES(${libraryId},${libraryId},${media},1,0,1,1)`,
      );
      yield* db.run(
        sql`INSERT INTO library_root_states(root_id,library_id,canonical_path,canonical_key,is_available,scan_generation,updated_at_ms) VALUES(${libraryId},${libraryId},${media},${media},1,0,1)`,
      );
    }).pipe(Effect.provide(makeDatabaseLayers({ databasePath } as never))),
  );
  const server = await startServer({
    databasePath,
    dataDir: join(root, "data"),
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  const base = new URL(server.server.url);
  const login = await fetch(new URL("/api/v1/auth/login", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "combined-episodes-password",
      deviceId: newUuid(),
      deviceName: "Combined episodes test",
      platform: "web",
      platformDeviceId: null,
    }),
  });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(new URL(`/api/v1/${path}`, base), {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  };
  const scan = async (mode: "full" | "incremental") => {
    const { runId } = await request<{ runId: string }>("scans", "POST", { libraryId, mode });
    let status = "queued";
    await eventually(async () => {
      status = (await request<{ status: string }>(`scans/${runId}`)).status;
      return !["queued", "running"].includes(status);
    }, 15_000);
    return status;
  };
  const episodes = async () => {
    const [show] = (await request<{ items: CatalogItem[] }>(`items?libraryId=${libraryId}`)).items;
    const [seasonItem] = (await request<{ items: CatalogItem[] }>(`items/${show?.id}/children`))
      .items;
    const list = (await request<{ items: CatalogItem[] }>(`items/${seasonItem?.id}/children`))
      .items;
    const byFile = (start: number, end: number | null) => {
      const found = list.find(
        (item) => item.indexNumber === start && (item.indexNumberEnd ?? null) === end,
      );
      if (found === undefined) throw new Error(`No entry for E${start}${end ? `-${end}` : ""}`);
      return found;
    };
    return {
      showId: show?.id ?? "",
      list,
      before: byFile(9, null),
      combined: byFile(10, 11),
      overlap: byFile(11, null),
      after: byFile(12, null),
    };
  };
  return { databasePath, request, scan, episodes };
};

test("a file named S03E10-11 is one playable entry that survives rescans with its watch state", async () => {
  const lib = await library();
  expect(await lib.scan("full")).toBe("succeeded");
  const first = await lib.episodes();
  expect(first.list.map((item) => [item.indexNumber, item.indexNumberEnd])).toEqual([
    [9, null],
    [10, 11],
    [11, null],
    [12, null],
  ]);
  const details = await lib.request<{
    item: { indexNumber: number; indexNumberEnd: number | null; durationSeconds: number };
    sources: unknown[];
  }>(`items/${first.combined.id}`);
  // One source and the whole file's probed duration: nothing is split or guessed.
  expect(details.item).toMatchObject({ indexNumber: 10, indexNumberEnd: 11, durationSeconds: 20 });
  expect(details.sources).toHaveLength(1);
  await lib.request(`items/${first.combined.id}/watch-state`, "PUT", {
    positionSeconds: 7,
    completed: false,
  });

  expect(await lib.scan("full")).toBe("succeeded");
  const rescanned = await lib.episodes();
  expect(rescanned.list.map((item) => item.id)).toEqual(first.list.map((item) => item.id));
  expect(rescanned.combined.resumePositionSeconds).toBe(7);

  // A database scanned before ranges existed holds the file as a single E10.
  const legacy = new SqliteDatabase(lib.databasePath);
  legacy.exec("PRAGMA busy_timeout = 5000");
  legacy
    .query("UPDATE catalog_items SET index_number_end = NULL WHERE id = ?")
    .run(first.combined.id);
  legacy.close();
  // An incremental scan leaves unchanged files alone; a full scan re-reads every path.
  expect(await lib.scan("incremental")).toBe("succeeded");
  expect(
    (await lib.request<{ item: CatalogItem }>(`items/${first.combined.id}`)).item.indexNumberEnd,
  ).toBeNull();
  expect(await lib.scan("full")).toBe("succeeded");
  const upgraded = await lib.episodes();
  expect(upgraded.list.map((item) => item.id)).toEqual(first.list.map((item) => item.id));
  expect(upgraded.combined).toMatchObject({
    id: first.combined.id,
    indexNumber: 10,
    indexNumberEnd: 11,
    resumePositionSeconds: 7,
  });
}, 60_000);

test("playback order and Next Up move past every episode a combined file covers", async () => {
  const lib = await library();
  expect(await lib.scan("full")).toBe("succeeded");
  const { showId, before, combined, overlap, after } = await lib.episodes();
  const adjacent = (id: string) =>
    lib.request<{ previous: CatalogItem | null; next: CatalogItem | null }>(
      `items/${id}/adjacent-episodes`,
    );
  expect((await adjacent(before.id)).next?.id).toBe(combined.id);
  // The separate E11 repeats what the combined file holds, so playback skips it both ways.
  expect(await adjacent(combined.id)).toMatchObject({
    previous: { id: before.id },
    next: { id: after.id },
  });
  expect((await adjacent(after.id)).previous?.id).toBe(overlap.id);

  const watched = (id: string) =>
    lib.request(`items/${id}/watch-state`, "PUT", { positionSeconds: 20, completed: true });
  const showNextUp = async () =>
    (await lib.request<{ item: CatalogItem | null }>(`items/${showId}/next-up`)).item?.id;
  const homeNextUp = async () =>
    (await lib.request<HomeContent>("home")).nextUp.map((item) => [item.id, item.indexNumberEnd]);
  expect(await showNextUp()).toBe(before.id);
  await watched(before.id);
  expect(await showNextUp()).toBe(combined.id);
  expect(await homeNextUp()).toEqual([[combined.id, 11]]);
  await watched(combined.id);
  expect(await showNextUp()).toBe(after.id);
  expect(await homeNextUp()).toEqual([[after.id, null]]);
}, 60_000);
