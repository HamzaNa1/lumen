import { Message } from "../../apps/server/src/http/Schemas";
import { afterEach, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { Database, sql } from "../../packages/database/src/index.ts";
import { Effect, Schema } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

import {
  CatalogItemDetails,
  CatalogItemPage,
  EpisodeOrderOptions,
  LoginResponse,
  MetadataMatchOptions,
  ScanJob,
  ScanRun,
  Uuid,
} from "../../packages/contracts/src/index.ts";
import { responseJson } from "../helpers/http";

const refreshResponse = Schema.Struct({ runId: Uuid });
const groupId = "641eb9d6b234b9007ac67063";
const nativeFetch = globalThis.fetch;
const poster = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9t8ncAAAAASUVORK5CYII=",
  "base64",
);
let running: RunningServer | undefined;
let root: string | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  globalThis.fetch = nativeFetch;
  if (root) await rm(root, { recursive: true, force: true });
});

/** Each episode entry's first and last episode; a single episode has no last. */
type Numbering = readonly [number, number | null];

/** A season of `episodes` single episodes, or of entries numbered as given. */
const fixture = async (episodes: number | ReadonlyArray<Numbering> = 2) => {
  const numbering: ReadonlyArray<Numbering> =
    typeof episodes === "number"
      ? Array.from({ length: episodes }, (_, i) => [i + 1, null])
      : episodes;
  root = await mkdtemp(join(tmpdir(), "lumen-episode-order-"));
  const databasePath = join(root, "catalog.sqlite");
  const layer = makeDatabaseLayers({ databasePath } as never);
  const library = newUuid(),
    show = newUuid(),
    season = newUuid();
  const episodeIds = numbering.map(() => newUuid());
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const password = yield* Effect.promise(() => hashPassword("episode-order-test-password"));
      for (const role of ["admin", "user"])
        yield* db.run(
          sql`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,is_active,created_at_ms,updated_at_ms) VALUES(${newUuid()},${role},${role},${role},${password},${role},1,1,1)`,
        );
      yield* db.run(
        sql`INSERT INTO libraries(id,name,slug,is_enabled,created_at_ms,updated_at_ms) VALUES(${library},'Anime','anime',1,1,1)`,
      );
      yield* db.run(sql`INSERT INTO library_profiles(library_id,kind) VALUES(${library},'shows')`);
      yield* db.run(
        sql`INSERT INTO library_roots(id,library_id,path,is_enabled,priority,created_at_ms,updated_at_ms) VALUES(${library},${library},${root},0,0,1,1)`,
      );
      yield* db.run(
        sql`INSERT INTO catalog_items(id,library_id,kind,title,sort_title,metadata_state,added_at_ms,updated_at_ms) VALUES(${show},${library},'show','Re:ZERO','re:zero','path',1,1)`,
      );
      yield* db.run(
        sql`INSERT INTO catalog_item_metadata(item_id,external_ids_json) VALUES(${show},'{"imdb":"tt5607616"}')`,
      );
      yield* db.run(
        sql`INSERT INTO catalog_items(id,library_id,kind,parent_id,title,sort_title,index_number,metadata_state,added_at_ms,updated_at_ms) VALUES(${season},${library},'season',${show},'Season 4','season 4',4,'path',1,1)`,
      );
      for (const [i, id] of episodeIds.entries()) {
        const [first, last] = numbering[i] ?? [i + 1, null];
        const code = `E${String(first).padStart(2, "0")}${last === null ? "" : `-E${last}`}`;
        yield* db.run(
          sql`INSERT INTO catalog_items(id,library_id,kind,parent_id,title,sort_title,index_number,index_number_end,duration_seconds,metadata_state,added_at_ms,updated_at_ms) VALUES(${id},${library},'episode',${season},${`Episode ${first}`},${`episode ${first}`},${first},${last},2640,'path',1,1)`,
        );
        yield* db.run(
          sql`INSERT INTO media_sources(id,library_id,root_id,relative_path,absolute_path,scanned_at_ms) VALUES(${id},${library},${library},${`ReZERO/Season 4/ReZERO S04${code}.mkv`},${`${root}/${i}.mkv`},1)`,
        );
        yield* db.run(
          sql`INSERT INTO catalog_item_sources(item_id,source_id,is_primary) VALUES(${id},${id},1)`,
        );
        // Already scanned: refresh is triggered by the HTTP request, not server startup.
        yield* db.run(
          sql`INSERT INTO provider_records(id,item_id,provider,provider_item_id,payload_json,confidence,fetched_at_ms,locked_fields_json) VALUES(${newUuid()},${id},'tmdb',${`65942:4:${first}`},'{}',95,1,'[]')`,
        );
      }
      if (episodeIds[2])
        yield* db.run(
          sql`INSERT INTO catalog_item_metadata(item_id,field_sources_json) VALUES(${episodeIds[2]},'{"title":"nfo"}')`,
        );
      yield* db.run(
        sql`INSERT INTO metadata_provider_settings(provider,api_key,updated_at_ms) VALUES('tmdb','fixture-key',1)`,
      );
    }).pipe(Effect.provide(layer)),
  );
  const upstream = {
    missingMapping: false,
    seasonStatus: 404,
    unavailable: false,
    mixedOutcome: false,
    missingEpisode: null as number | null,
    lastEpisodeStarted: () => {},
    waitForLastEpisode: async () => {},
  };
  const episodeAttempts = new Map<number, number>();
  let finalAttempts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "image.tmdb.org")
      return url.pathname === "/t/p/w92/poster.png"
        ? new Response(poster, { headers: { "content-type": "image/png" } })
        : new Response(null, { status: 404 });
    if (url.hostname !== "api.themoviedb.org") return nativeFetch(input, init);
    if (upstream.unavailable) return new Response(null, { status: 503 });
    const path = url.pathname;
    if (path === "/3/find/tt5607616") return Response.json({ tv_results: [{ id: 65942 }] });
    if (path === "/3/tv/65942" || path === "/3/tv/123") return Response.json({ name: "Re:ZERO" });
    if (path === "/3/search/tv")
      return Response.json({
        results:
          url.searchParams.get("query") === "Re:ZERO"
            ? [
                {
                  id: 65942,
                  name: "Re:ZERO",
                  first_air_date: "2016-04-04",
                  overview: "Starting life in another world",
                  poster_path: "/poster.png",
                },
                {
                  id: 123,
                  name: "Re:ZERO Break Time",
                  first_air_date: "",
                  poster_path: "/gone.png",
                },
                { id: 124, first_air_date: "2020-01-01" },
              ]
            : [],
      });
    if (path.endsWith("/episode_groups"))
      return Response.json({
        results: path.includes("65942")
          ? [{ id: groupId, name: "Seasons", description: "Production seasons", type: 6 }]
          : [],
      });
    if (path === `/3/tv/episode_group/${groupId}`)
      return Response.json({
        groups: [
          {
            order: 4,
            episodes: upstream.missingMapping
              ? []
              : Array.from({ length: 19 }, (_, order) => ({
                  order,
                  season_number: 1,
                  episode_number: 67 + order,
                })),
          },
        ],
      });
    if (/\/season\/4$/u.test(path)) return new Response(null, { status: upstream.seasonStatus });
    if (path.includes("/episode/")) {
      const episode = Number(path.split("/").at(-1));
      if (episode === upstream.missingEpisode) return new Response(null, { status: 404 });
      if (upstream.mixedOutcome) {
        const attempts = (episodeAttempts.get(episode) ?? 0) + 1;
        episodeAttempts.set(episode, attempts);
        if (attempts < 3) return new Response(null, { status: 503 });
        if (++finalAttempts === 1) return new Response(null, { status: 404 });
        upstream.lastEpisodeStarted();
        await upstream.waitForLastEpisode();
      }
      return Response.json({
        overview: `Synopsis ${episode}`,
        name:
          episode >= 67
            ? episode === 67
              ? "Mapped premiere"
              : `Mapped episode ${episode - 66}`
            : `Default episode ${episode}`,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const config = { databasePath, dataDir: join(root, "data"), host: "127.0.0.1", port: 0 };
  running = await startServer(config);
  let base = new URL(running.server.url);
  const login = async (username: string) => {
    const res = await fetch(new URL("/api/v1/auth/login", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "episode-order-test-password",
        deviceId: newUuid(),
        deviceName: "Episode order test",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(res.status).toBe(200);
    return (await responseJson(LoginResponse, res)).accessToken;
  };
  const admin = await login("admin"),
    viewer = await login("user");
  const request = (path: string, method = "GET", body?: unknown, token = admin) =>
    fetch(new URL(`/api/v1/${path}`, base), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const orderPath = `items/${show}/episode-order`;
  const save = (id: string | null = groupId, series = "65942") =>
    request(orderPath, "PUT", { tmdbSeriesId: series, groupId: id });
  const waitForRun = async (response: Response) => {
    expect(response.status).toBe(200);
    const { runId } = await responseJson(refreshResponse, response);
    for (let i = 0; i < 200; i++) {
      const status = await responseJson(ScanRun, request(`scans/${runId}`));
      if (!["queued", "running"].includes(status.status)) return status;
      await Bun.sleep(100);
    }
    throw new Error("Metadata refresh did not finish");
  };
  const restart = async () => {
    await running?.stop();
    running = await startServer(config);
    base = new URL(running.server.url);
  };
  return {
    show,
    season,
    episodes: episodeIds,
    databasePath,
    upstream,
    request,
    orderPath,
    save,
    viewer,
    waitForRun,
    restart,
  };
};

test("admins select a persisted episode order and refresh titles without changing local identity or user metadata", async () => {
  const f = await fixture(19);
  const options = await f.request(f.orderPath);
  expect(options.status).toBe(200);
  expect(await options.json()).toEqual({
    tmdbSeriesId: "65942",
    groupId: null,
    groups: [
      { id: groupId, name: "Seasons", description: "Production seasons", type: "Production" },
    ],
  });
  expect((await f.request(f.orderPath, "GET", undefined, f.viewer)).status).toBe(403);
  expect(
    (await f.request(f.orderPath, "PUT", { tmdbSeriesId: "65942", groupId }, f.viewer)).status,
  ).toBe(403);
  expect((await f.save("aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(400);
  expect((await f.save(groupId, "123")).status).toBe(400);
  expect((await f.request(`items/${f.season}/episode-order`)).status).toBe(400);
  const episode = `items/${f.episodes[0]}`;
  expect(
    (await f.request(`${episode}/watch-state`, "PUT", { positionSeconds: 12, completed: true }))
      .status,
  ).toBe(200);
  expect((await f.request(`${episode}/favorite`, "PUT", { isFavorite: true })).status).toBe(200);
  expect(
    (await f.request(`items/${f.episodes[1]}/metadata`, "PATCH", { title: "My episode title" }))
      .status,
  ).toBe(200);
  expect((await f.waitForRun(await f.save())).status).toBe("succeeded");
  const details = await responseJson(CatalogItemDetails, f.request(episode));
  expect(details.item).toMatchObject({
    id: f.episodes[0],
    parentId: f.season,
    indexNumber: 1,
    title: "Mapped premiere",
  });
  expect(details.watchState).toMatchObject({ completed: true, positionSeconds: 12 });
  expect(details.isFavorite).toBe(true);
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${f.episodes[1]}`))).item.title,
  ).toBe("My episode title");
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${f.season}`))).item,
  ).toMatchObject({
    indexNumber: 4,
    title: "Season 4",
  });
  const children = await responseJson(CatalogItemPage, f.request(`items/${f.season}/children`));
  expect(children.items).toHaveLength(19);
  expect(children.items.map((item) => [item.indexNumber, item.title])).toEqual(
    Array.from({ length: 19 }, (_, i) => [
      i + 1,
      i === 0
        ? "Mapped premiere"
        : i === 1
          ? "My episode title"
          : i === 2
            ? "Episode 3"
            : `Mapped episode ${i + 1}`,
    ]),
  );
  await f.restart();
  expect((await responseJson(EpisodeOrderOptions, f.request(f.orderPath))).groupId).toBe(groupId);
  expect((await f.waitForRun(await f.save(null))).status).toBe("succeeded");
  expect((await responseJson(CatalogItemDetails, f.request(episode))).item.title).toBe(
    "Default episode 1",
  );
  expect((await responseJson(EpisodeOrderOptions, f.request(f.orderPath))).groupId).toBeNull();
}, 30_000);

test("unmatched groups fail visibly without overwriting episode titles or silently using the default order", async () => {
  const f = await fixture();
  f.upstream.missingMapping = true;
  const response = await f.save();
  const { runId } = await responseJson(refreshResponse, response.clone());
  expect((await f.waitForRun(response)).status).toBe("failed");
  const jobs = await responseJson(Schema.Array(ScanJob), f.request(`scans/${runId}/jobs`));
  expect(
    jobs.every((job: { status: string }) => ["failed", "succeeded"].includes(job.status)),
  ).toBe(true);
  expect(jobs.some((job) => job.errorMessage?.includes("Choose another episode order"))).toBe(true);
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${f.episodes[0]}`))).item.title,
  ).toBe("Episode 1");
}, 30_000);

test("provider errors do not reset an order, and rematching a show clears its old order", async () => {
  const f = await fixture();
  expect((await f.waitForRun(await f.save())).status).toBe("succeeded");
  f.upstream.unavailable = true;
  expect((await f.request(f.orderPath)).status).toBe(503);
  expect((await f.save(null)).status).toBe(503);
  f.upstream.unavailable = false;
  expect((await responseJson(EpisodeOrderOptions, f.request(f.orderPath))).groupId).toBe(groupId);
  expect((await f.request(`items/${f.show}/match`, "PUT", { tmdbId: "123" })).status).toBe(200);
  expect(await responseJson(EpisodeOrderOptions, f.request(f.orderPath))).toMatchObject({
    tmdbSeriesId: "123",
    groupId: null,
    groups: [],
  });
}, 30_000);

test("admins see possible matches, pick one by search or ID, and the refresh follows it", async () => {
  const f = await fixture();
  const matchPath = `items/${f.show}/match`;
  expect(await responseJson(MetadataMatchOptions, f.request(matchPath))).toEqual({
    tmdbId: null,
    query: "Re:ZERO",
    candidates: [
      {
        tmdbId: "65942",
        title: "Re:ZERO",
        year: 2016,
        overview: "Starting life in another world",
        posterUrl: `data:image/png;base64,${poster.toString("base64")}`,
      },
      { tmdbId: "123", title: "Re:ZERO Break Time", year: null, overview: "", posterUrl: null },
    ],
  });
  expect(await responseJson(MetadataMatchOptions, f.request(`${matchPath}?query=123`))).toEqual({
    tmdbId: null,
    query: "123",
    candidates: [{ tmdbId: "123", title: "Re:ZERO", year: null, overview: "", posterUrl: null }],
  });
  expect(
    (await responseJson(MetadataMatchOptions, f.request(`${matchPath}?query=999`))).candidates,
  ).toEqual([]);
  expect((await f.request(matchPath, "GET", undefined, f.viewer)).status).toBe(403);
  expect((await f.request(matchPath, "PUT", { tmdbId: "123" }, f.viewer)).status).toBe(403);
  expect((await f.request(`items/${f.season}/match`)).status).toBe(400);
  expect((await f.request(`${matchPath}?query=${"a".repeat(201)}`)).status).toBe(400);

  const unknown = await f.request(matchPath, "PUT", { tmdbId: "999" });
  expect(unknown.status).toBe(400);
  expect((await responseJson(Message, unknown)).message).toContain("no series with ID 999");
  expect((await f.request(matchPath, "PUT", { tmdbId: "12345678901" })).status).toBe(400);
  expect((await responseJson(MetadataMatchOptions, f.request(matchPath))).tmdbId).toBeNull();

  expect((await f.waitForRun(await f.request(matchPath, "PUT", { tmdbId: "123" }))).status).toBe(
    "succeeded",
  );
  expect((await responseJson(MetadataMatchOptions, f.request(matchPath))).tmdbId).toBe("123");
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${f.episodes[0]}`))).item.title,
  ).toBe("Default episode 1");

  f.upstream.unavailable = true;
  expect((await f.request(matchPath)).status).toBe(503);
  expect((await f.request(matchPath, "PUT", { tmdbId: "65942" })).status).toBe(503);
  f.upstream.unavailable = false;
  expect((await responseJson(MetadataMatchOptions, f.request(matchPath))).tmdbId).toBe("123");
}, 30_000);

test("a non-404 season failure still fails the refresh and preserves local episode metadata", async () => {
  const f = await fixture();
  f.upstream.seasonStatus = 429;
  expect((await f.waitForRun(await f.save(null))).status).toBe("failed");
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${f.episodes[0]}`))).item.title,
  ).toBe("Episode 1");
}, 30_000);

test("a mixed refresh stays running until its last episode completes, then reports the failure", async () => {
  const f = await fixture();
  f.upstream.mixedOutcome = true;
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lastStarted = new Promise<void>((resolve) => {
    f.upstream.lastEpisodeStarted = resolve;
  });
  f.upstream.waitForLastEpisode = () => blocked;
  const saved = await f.save();
  expect(saved.status).toBe(200);
  const { runId } = await responseJson(refreshResponse, saved.clone());
  try {
    await lastStarted;
    const progress = await responseJson(ScanRun, f.request(`scans/${runId}`));
    expect(progress.status).toBe("running");
  } finally {
    release();
  }
  expect((await f.waitForRun(saved)).status).toBe("failed");
  const jobs = await responseJson(Schema.Array(ScanJob), f.request(`scans/${runId}/jobs`));
  expect(jobs.map((job: { status: string }) => job.status).sort()).toEqual(["failed", "succeeded"]);
  const children = await responseJson(CatalogItemPage, f.request(`items/${f.season}/children`));
  expect(
    children.items.filter((item: { title: string }) => item.title.startsWith("Mapped")),
  ).toHaveLength(1);
}, 30_000);

test("a combined file takes every covered episode's metadata in the selected order, keeping its range, runtime and state", async () => {
  const f = await fixture([
    [1, 2],
    [3, null],
  ]);
  const [combined, third] = f.episodes;
  const entry = `items/${combined}`;
  expect(
    (await f.request(`${entry}/watch-state`, "PUT", { positionSeconds: 95, completed: false }))
      .status,
  ).toBe(200);
  expect((await f.waitForRun(await f.save())).status).toBe("succeeded");
  const mapped = await responseJson(CatalogItemDetails, f.request(entry));
  expect(mapped.item).toMatchObject({
    id: combined,
    indexNumber: 1,
    indexNumberEnd: 2,
    title: "Mapped premiere / Mapped episode 2",
    overview: "Synopsis 67\n\nSynopsis 68",
    // The file's own runtime, not one episode's.
    durationSeconds: 2640,
  });
  expect(mapped.watchState).toMatchObject({ positionSeconds: 95, completed: false });
  expect((await responseJson(CatalogItemDetails, f.request(`items/${third}`))).item.title).toBe(
    "Mapped episode 3",
  );
  const records = new SqliteDatabase(f.databasePath, { readonly: true });
  expect(
    records
      .query("SELECT provider_item_id AS id FROM provider_records WHERE item_id = ?")
      .all(combined ?? ""),
  ).toEqual([{ id: "65942:1:67,65942:1:68" }]);
  records.close();

  expect((await f.waitForRun(await f.save(null))).status).toBe("succeeded");
  expect((await responseJson(CatalogItemDetails, f.request(entry))).item).toMatchObject({
    title: "Default episode 1 / Default episode 2",
    overview: "Synopsis 1\n\nSynopsis 2",
    indexNumberEnd: 2,
  });
  expect(
    (await f.request(`${entry}/metadata`, "PATCH", { title: "Two-part premiere" })).status,
  ).toBe(200);
  expect((await f.waitForRun(await f.save())).status).toBe("succeeded");
  expect((await responseJson(CatalogItemDetails, f.request(entry))).item).toMatchObject({
    title: "Two-part premiere",
    overview: "Synopsis 67\n\nSynopsis 68",
  });
}, 30_000);

test("a combined file whose second episode TMDb lacks keeps its local title and range and fails visibly", async () => {
  const f = await fixture([
    [1, 2],
    [3, null],
  ]);
  const [combined, third] = f.episodes;
  f.upstream.missingEpisode = 2;
  const response = await f.save(null);
  const { runId } = await responseJson(refreshResponse, response.clone());
  expect((await f.waitForRun(response)).status).toBe("failed");
  const jobs = await responseJson(Schema.Array(ScanJob), f.request(`scans/${runId}/jobs`));
  expect(
    jobs
      .filter((job: { status: string }) => job.status === "failed")
      .map((job) => job.errorMessage),
  ).toEqual(["TMDb returned 404"]);
  expect(
    (await responseJson(CatalogItemDetails, f.request(`items/${combined}`))).item,
  ).toMatchObject({
    title: "Episode 1",
    overview: null,
    indexNumber: 1,
    indexNumberEnd: 2,
  });
  expect((await responseJson(CatalogItemDetails, f.request(`items/${third}`))).item.title).toBe(
    "Default episode 3",
  );
  f.upstream.missingEpisode = null;
  expect((await f.waitForRun(await f.save(null))).status).toBe("succeeded");
  expect((await responseJson(CatalogItemDetails, f.request(`items/${combined}`))).item.title).toBe(
    "Default episode 1 / Default episode 2",
  );
}, 30_000);
