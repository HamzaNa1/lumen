import { afterEach, expect, test } from "bun:test";
import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { makeMediaIngest } from "../../apps/server/src/media/MediaIngest";
import { readLocalFile, readResponseBytes } from "../../apps/server/src/media/BoundedInput";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { makeScanner } from "../../apps/server/src/services/Scanner";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

const must = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Expected a catalog entry");
  return value;
};

const paths: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

test("untrusted metadata reads stop at the byte limit and reject symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-metadata-limits-"));
  paths.push(root);
  const source = join(root, "metadata.nfo");
  await writeFile(source, "12345");
  await symlink(source, join(root, "linked.nfo"));
  expect(await readLocalFile(source, 4)).toBeNull();
  expect(await readLocalFile(join(root, "linked.nfo"), 10)).toBeNull();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); } }));
  await expect(readResponseBytes(response, 4)).rejects.toThrow("size limit");
});

test("video folders browse as series, seasons, episodes and movies without required sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-video-catalog-"));
  paths.push(root);
  const showsRoot = join(root, "shows");
  const moviesRoot = join(root, "movies");
  const movieFolder = "Movie Name (2021) [imdbid-tt1234567]";
  for (const path of [join(showsRoot, "House", "Season 1"), join(showsRoot, "House", "Season 2"), join(moviesRoot, movieFolder)]) await mkdir(path, { recursive: true });
  const episodes = ["House/Season 1/House S01E01.mkv", "House/Season 1/House S01E02.mkv", "House/Season 2/House S02E01.mkv"];
  for (const relative of episodes) await writeFile(join(showsRoot, relative), "video");
  await writeFile(join(moviesRoot, movieFolder, "Movie Name (2021).mkv"), "video");
  const databasePath = join(root, "catalog.sqlite");
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer), Layer.succeed(Ffprobe, {
    probe: () => Effect.succeed({ durationMs: 60_000, streams: [{ kind: "video" as const, ordinal: 0, codec: "h264", bitrate: null, sampleRateHz: null, channels: null, width: 1920, height: 1080, language: null, title: null, isDefault: true }], tags: {} }),
  }));
  const ids = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* Database;
    const ingest = yield* makeMediaIngest;
    const adminId = newUuid();
    const viewerId = newUuid();
    const showsId = newUuid();
    const moviesId = newUuid();
    const showRootId = newUuid();
    const movieRootId = newUuid();
    const passwordHash = yield* Effect.promise(() => hashPassword("correct horse battery staple"));
    const sourceIds: string[] = [];
    for (const [id, username, role] of [[adminId, "admin", "admin"], [viewerId, "viewer", "user"]]) yield* db.run(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${id}, ${username}, ${username}, ${username}, ${passwordHash}, ${role}, 1, 1, 1)
    `);
    for (const [id, name, kind, rootId, path] of [[showsId, "Shows", "shows", showRootId, showsRoot], [moviesId, "Movies", "movies", movieRootId, moviesRoot]]) {
      yield* db.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${id}, ${name}, ${kind}, 1, 1, 1)`);
      yield* db.run(sql`INSERT INTO library_profiles(library_id, kind) VALUES (${id}, ${kind})`);
      yield* db.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${id}, ${path}, 1, 0, 1, 1)`);
    }
    for (const [libraryId, rootId, rootPath, relative] of [
      ...episodes.map((path) => [showsId, showRootId, showsRoot, path]),
      [moviesId, movieRootId, moviesRoot, `${movieFolder}/Movie Name (2021).mkv`],
    ]) {
      const sourceId = newUuid();
      sourceIds.push(sourceId);
      const fileDetails = yield* Effect.promise(() => stat(join(rootPath, relative)));
      yield* db.run(sql`
        INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
        VALUES (${sourceId}, ${libraryId}, ${rootId}, ${relative}, ${join(rootPath, relative)}, 'local', ${fileDetails.size}, 1, ${String(fileDetails.ino)}, 1)
      `);
      yield* ingest.ingest(sourceId);
      yield* ingest.ingest(sourceId);
    }
    yield* db.run(sql`INSERT INTO server_scan_state(root_id, generation, updated_at_ms) VALUES (${showRootId}, 1, 1)`);
    return { showsId, moviesId, showRootId, adminId, viewerId, sourceIds };
  }).pipe(Effect.provide(layer)));
  const server = await startServer({ databasePath, dataDir: join(root, "data"), host: "127.0.0.1", port: 0 });
  servers.push(server);
  const base = new URL(server.server.url);
  const login = async (username: string) => {
    const response = await fetch(new URL("/api/v1/auth/login", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "correct horse battery staple", deviceId: newUuid(), deviceName: "Catalog test", platform: "web", platformDeviceId: null }) });
    expect(response.status).toBe(200);
    return (await response.json() as { accessToken: string }).accessToken;
  };
  const admin = await login("admin");
  const viewer = await login("viewer");
  const get = async (path: string, token: string) => fetch(new URL(path, base), { headers: { authorization: `Bearer ${token}` } });
  const shows = await (await get(`/api/v1/items?libraryId=${ids.showsId}`, admin)).json() as { items: { id: string; title: string; kind: string; artworkId: string | null }[] };
  expect(shows.items).toEqual([expect.objectContaining({ title: "House", kind: "show" })]);
  const showId = must(shows.items[0]).id;
  expect(must(shows.items[0]).artworkId).toBeNull();
  const seasons = await (await get(`/api/v1/items/${showId}/children`, admin)).json() as { items: { id: string; title: string; kind: string }[] };
  expect(seasons.items.map((item) => item.title)).toEqual(["Season 1", "Season 2"]);
  const firstSeason = await (await get(`/api/v1/items/${must(seasons.items[0]).id}/children`, admin)).json() as { items: { id: string; indexNumber: number }[] };
  expect(firstSeason.items.map((item) => item.indexNumber)).toEqual([1, 2]);
  const movies = await (await get(`/api/v1/items?libraryId=${ids.moviesId}`, admin)).json() as { items: { id: string; title: string; year: number; kind: string }[] };
  expect(movies.items).toEqual([expect.objectContaining({ title: "Movie Name", year: 2021, kind: "movie" })]);
  await writeFile(join(showsRoot, "House", "tvshow.nfo"), "<tvshow><title>House</title><plot>A local synopsis.</plot><genre>Drama</genre><rating>8.5</rating></tvshow>");
  await writeFile(join(showsRoot, "House", "poster.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9t8ncAAAAASUVORK5CYII=", "base64"));
  await Effect.runPromise(Effect.gen(function* () {
    const ingest = yield* makeMediaIngest;
    for (const sourceId of ids.sourceIds) yield* ingest.ingest(sourceId);
  }).pipe(Effect.provide(layer)));
  const showDetails = await (await get(`/api/v1/items/${showId}`, admin)).json() as { item: { overview: string; genresJson: string; communityRating: number; artworkId: string }; metadataProviderConfigured: boolean };
  expect(showDetails.metadataProviderConfigured).toBe(false);
  expect(showDetails.item.overview).toBe("A local synopsis.");
  expect(JSON.parse(showDetails.item.genresJson)).toEqual(["Drama"]);
  expect(showDetails.item.communityRating).toBe(8.5);
  expect((await get(`/api/v1/artwork/${showDetails.item.artworkId}`, admin)).status).toBe(200);
  expect((await get(`/api/v1/artwork/${showDetails.item.artworkId}`, viewer)).status).toBe(403);
  const replacementPoster = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AABQMBgJ5Smn8AAAAASUVORK5CYII=", "base64");
  await writeFile(join(showsRoot, "House", "poster.png"), replacementPoster);
  await Effect.runPromise(Effect.gen(function* () { yield* (yield* makeMediaIngest).ingest(must(ids.sourceIds[0])); }).pipe(Effect.provide(layer)));
  const artworkRow = await Effect.runPromise(Effect.gen(function* () {
    return yield* (yield* Database).get<{ contentHash: string; byteSize: number }>(sql`
      SELECT content_hash AS contentHash, byte_size AS byteSize FROM artwork WHERE id = ${showDetails.item.artworkId}
    `);
  }).pipe(Effect.provide(layer)));
  expect(artworkRow?.contentHash).toBe(createHash("sha256").update(replacementPoster).digest("hex"));
  expect(artworkRow?.byteSize).toBe(replacementPoster.length);
  const startPlayback = (itemId: string) => fetch(new URL("/api/v1/playback/sessions", base), {
    method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ trackId: itemId }),
  });
  expect((await startPlayback(must(firstSeason.items[0]).id)).status).toBe(201);
  expect((await startPlayback(must(movies.items[0]).id)).status).toBe(201);
  expect((await startPlayback(showId)).status).toBe(404);
  expect((await startPlayback(must(seasons.items[0]).id)).status).toBe(404);
  const nextUpBefore = await (await get(`/api/v1/items/${showId}/next-up`, admin)).json() as { item: { id: string } };
  expect(nextUpBefore.item.id).toBe(must(firstSeason.items[0]).id);
  const watched = await fetch(new URL(`/api/v1/items/${must(firstSeason.items[0]).id}/watch-state`, base), { method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ positionSeconds: 60, completed: true }) });
  expect(watched.status).toBe(200);
  const nextUpAfter = await (await get(`/api/v1/items/${showId}/next-up`, admin)).json() as { item: { id: string } };
  expect(nextUpAfter.item.id).toBe(must(firstSeason.items[1]).id);
  const denied = await get(`/api/v1/items/${showId}`, viewer);
  expect(denied.status).toBe(403);
  const grant = await fetch(new URL(`/api/v1/libraries/${ids.showsId}/grants`, base), {
    method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ id: newUuid(), libraryId: ids.showsId, userId: ids.viewerId, role: "user", capabilities: ["library:read"], canDownload: false, expiresAtMs: null }),
  });
  expect(grant.status).toBe(200);
  const viewerNextUp = await (await get(`/api/v1/items/${showId}/next-up`, viewer)).json() as { item: { id: string } };
  expect(viewerNextUp.item.id).toBe(must(firstSeason.items[0]).id);
  const edit = await fetch(new URL(`/api/v1/items/${showId}/metadata`, base), {
    method: "PATCH", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Dr. House" }),
  });
  expect(edit.status).toBe(200);
  const favorite = await fetch(new URL(`/api/v1/items/${must(firstSeason.items[0]).id}/favorite`, base), {
    method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ isFavorite: true }),
  });
  expect(favorite.status).toBe(200);
  await Effect.runPromise(Effect.gen(function* () {
    const ingest = yield* makeMediaIngest;
    for (const sourceId of ids.sourceIds) yield* ingest.ingest(sourceId);
  }).pipe(Effect.provide(layer)));
  const rescanned = await (await get(`/api/v1/items?libraryId=${ids.showsId}`, admin)).json() as { items: { id: string; title: string }[] };
  expect(rescanned.items).toHaveLength(1);
  expect(rescanned.items[0]).toEqual(expect.objectContaining({ id: showId, title: "Dr. House" }));
  const progress = await (await get(`/api/v1/items/${must(firstSeason.items[0]).id}`, admin)).json() as { watchState: { completed: boolean }; isFavorite: boolean };
  expect(progress.watchState.completed).toBe(true);
  expect(progress.isFavorite).toBe(true);
  await server.stop();
  servers.pop();
  await rename(join(showsRoot, must(episodes[0])), join(showsRoot, "House/Season 1/House S01E01 Renamed.mkv"));
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* Database;
    const scanner = yield* makeScanner;
    const runId = newUuid();
    yield* db.run(sql`INSERT INTO scan_runs(id, library_id, mode, status, started_at_ms, created_at_ms) VALUES (${runId}, ${ids.showsId}, 'full', 'running', 1, 1)`);
    yield* scanner.discover(runId, ids.showRootId);
    yield* scanner.cleanup(runId, ids.showRootId);
    const ingest = yield* makeMediaIngest;
    yield* ingest.ingest(must(ids.sourceIds[0]));
    yield* db.run(sql`DELETE FROM scan_jobs WHERE run_id = ${runId}`);
    yield* db.run(sql`UPDATE scan_runs SET status = 'succeeded', finished_at_ms = 1 WHERE id = ${runId}`);
  }).pipe(Effect.provide(layer)));
  const nativeFetch = globalThis.fetch;
  let providerAvailable = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    if (url.hostname === "api.themoviedb.org") {
      if (!providerAvailable) return Promise.resolve(new Response("unavailable", { status: 503 }));
      const path = url.pathname;
      const payload = path === "/3/find/tt1234567"
        ? { movie_results: [{ id: 789 }], tv_results: [] }
        : path === "/3/movie/789"
          ? { id: 789, title: "Movie Name", overview: "Remote movie", release_date: "2021-01-01" }
        : path === "/3/search/tv"
        ? { results: [{ id: 123, name: "Dr. House", first_air_date: "2004-11-16" }] }
        : path === "/3/tv/123"
          ? { id: 123, name: "House", overview: "Remote overview", first_air_date: "2004-11-16", vote_average: 9.1 }
          : path === "/3/tv/456"
            ? { id: 456, name: "House", overview: "Corrected match", first_air_date: "2005-11-16", vote_average: 9.2 }
          : path.includes("/episode/")
            ? { id: 1, name: "Pilot", overview: "Remote episode", air_date: "2004-11-16", still_path: "/still.png" }
            : { id: 1, name: "Season 1", overview: "Remote season", air_date: "2004-11-16", poster_path: "/season.png" };
      return Promise.resolve(Response.json(payload));
    }
    if (url.hostname === "image.tmdb.org") return Promise.resolve(new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9t8ncAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } }));
    return nativeFetch(input, init);
  }) as typeof fetch;
  try {
    const enrichedServer = await startServer({ databasePath, dataDir: join(root, "data"), host: "127.0.0.1", port: 0 });
    servers.push(enrichedServer);
    const remoteBase = new URL(enrichedServer.server.url);
    const remoteGet = (path: string) => fetch(new URL(path, remoteBase), { headers: { authorization: `Bearer ${admin}` } });
    const settingPath = new URL("/api/v1/admin/metadata-settings", remoteBase);
    expect((await remoteGet(settingPath.pathname)).status).toBe(200);
    expect(await (await remoteGet(settingPath.pathname)).json()).toEqual({ tmdbConfigured: false });
    expect((await fetch(settingPath, { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(403);
    expect((await fetch(settingPath, { method: "PUT", headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json" }, body: JSON.stringify({ tmdbApiKey: "test" }) })).status).toBe(403);
    const savedSetting = await fetch(settingPath, { method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ tmdbApiKey: "test" }) });
    expect(savedSetting.status).toBe(200);
    expect(await savedSetting.json()).toEqual({ tmdbConfigured: true });
    expect((await stat(databasePath)).mode & 0o077).toBe(0);
    expect((await stat(`${databasePath}-wal`)).mode & 0o077).toBe(0);
    expect(await (await remoteGet(settingPath.pathname)).json()).toEqual({ tmdbConfigured: true });
    expect((await (await remoteGet(`/api/v1/items/${showId}`)).json() as { metadataProviderConfigured: boolean }).metadataProviderConfigured).toBe(true);
    const movedEpisodes = await (await remoteGet(`/api/v1/items/${must(seasons.items[0]).id}/children`)).json() as { items: { id: string }[] };
    expect(movedEpisodes.items.map((episode) => episode.id)).toEqual(firstSeason.items.map((episode) => episode.id));
    let enrichedEpisodeTitle: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await remoteGet(`/api/v1/items/${must(firstSeason.items[0]).id}`);
      enrichedEpisodeTitle = ((await response.json()) as { item: { title: string } }).item.title;
      if (enrichedEpisodeTitle === "Pilot") break;
      await Bun.sleep(100);
    }
    expect(enrichedEpisodeTitle).toBe("Pilot");
    const refresh = await fetch(new URL(`/api/v1/items/${showId}/refresh`, remoteBase), { method: "POST", headers: { authorization: `Bearer ${admin}` } });
    expect(refresh.status).toBe(200);
    const enrichedShow = await (await remoteGet(`/api/v1/items/${showId}`)).json() as { item: { title: string; overview: string; year: number; communityRating: number } };
    expect(enrichedShow.item.title).toBe("Dr. House");
    expect(enrichedShow.item.overview).toBe("A local synopsis.");
    expect(enrichedShow.item.year).toBe(2004);
    expect(enrichedShow.item.communityRating).toBe(8.5);
    expect((await fetch(new URL(`/api/v1/items/${must(movies.items[0]).id}/refresh`, remoteBase), { method: "POST", headers: { authorization: `Bearer ${admin}` } })).status).toBe(200);
    let movieOverview: string | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      movieOverview = ((await (await remoteGet(`/api/v1/items/${must(movies.items[0]).id}`)).json()) as { item: { overview: string | null } }).item.overview;
      if (movieOverview === "Remote movie") break;
      await Bun.sleep(100);
    }
    expect(movieOverview).toBe("Remote movie");
    const enrichedSeasons = await (await remoteGet(`/api/v1/items/${showId}/children`)).json() as { items: { artworkId: string | null }[] };
    expect(must(enrichedSeasons.items[0]).artworkId).toBeString();
    expect((await fetch(new URL(`/api/v1/artwork/${must(enrichedSeasons.items[0]).artworkId}`, remoteBase), { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(200);
    expect((await readdir(join(root, "data", "artwork"))).length).toBeGreaterThan(0);
    const match = await fetch(new URL(`/api/v1/items/${showId}/match`, remoteBase), {
      method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ tmdbId: "456" }),
    });
    expect(match.status).toBe(200);
    let correctedYear: number | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      correctedYear = ((await (await remoteGet(`/api/v1/items/${showId}`)).json()) as { item: { year: number } }).item.year;
      if (correctedYear === 2005) break;
      await Bun.sleep(100);
    }
    expect(correctedYear).toBe(2005);
    await writeFile(join(showsRoot, "House", "tvshow.nfo"), "<tvshow><title>House</title><plot>A local synopsis.</plot><uniqueid type=\"tmdb\">123</uniqueid></tvshow>");
    await Effect.runPromise(Effect.gen(function* () { yield* (yield* makeMediaIngest).ingest(must(ids.sourceIds[1])); }).pipe(Effect.provide(layer)));
    const correctedDetails = await (await remoteGet(`/api/v1/items/${showId}`)).json() as { item: { externalIdsJson: string } };
    expect(JSON.parse(correctedDetails.item.externalIdsJson).tmdb).toBe("456");
    const clinicRelative = "Clinic/Season 1/Clinic S01E01.mkv";
    await mkdir(join(showsRoot, "Clinic", "Season 1"), { recursive: true });
    await writeFile(join(showsRoot, clinicRelative), "video");
    await writeFile(join(showsRoot, "Clinic", "poster.png"), replacementPoster);
    const clinicSourceId = newUuid();
    const clinicDetails = await stat(join(showsRoot, clinicRelative));
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(sql`
        INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
        VALUES (${clinicSourceId}, ${ids.showsId}, ${ids.showRootId}, ${clinicRelative}, ${join(showsRoot, clinicRelative)},
          'local', ${clinicDetails.size}, 1, ${String(clinicDetails.ino)}, 1)
      `);
      yield* (yield* makeMediaIngest).ingest(clinicSourceId);
    }).pipe(Effect.provide(layer)));
    const withClinic = await (await remoteGet(`/api/v1/items?libraryId=${ids.showsId}`)).json() as { items: { title: string; artworkId: string }[] };
    const clinicArtworkId = must(withClinic.items.find((entry) => entry.title === "Clinic")).artworkId;
    expect(clinicArtworkId).not.toBe(showDetails.item.artworkId);
    await rm(join(showsRoot, "House", "poster.png"));
    expect((await remoteGet(`/api/v1/artwork/${clinicArtworkId}`)).status).toBe(200);
    providerAvailable = false;
    expect((await fetch(new URL(`/api/v1/items/${showId}/refresh`, remoteBase), { method: "POST", headers: { authorization: `Bearer ${admin}` } })).status).toBe(200);
    await Bun.sleep(250);
    expect((await remoteGet(`/api/v1/items/${showId}`)).status).toBe(200);
    await enrichedServer.stop();
    servers.pop();
    const restartedServer = await startServer({ databasePath, dataDir: join(root, "data"), host: "127.0.0.1", port: 0 });
    servers.push(restartedServer);
    const restartedSettings = new URL("/api/v1/admin/metadata-settings", restartedServer.server.url);
    expect(await (await fetch(restartedSettings, { headers: { authorization: `Bearer ${admin}` } })).json()).toEqual({ tmdbConfigured: true });
    const cleared = await fetch(restartedSettings, { method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ tmdbApiKey: null }) });
    expect(await cleared.json()).toEqual({ tmdbConfigured: false });
    expect((await (await fetch(new URL(`/api/v1/items/${showId}`, restartedServer.server.url), { headers: { authorization: `Bearer ${admin}` } })).json() as { metadataProviderConfigured: boolean }).metadataProviderConfigured).toBe(false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
}, 20_000);
