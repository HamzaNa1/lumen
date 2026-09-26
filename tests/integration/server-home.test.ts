import { afterEach, expect, test } from "bun:test";
import { Database, sql } from "../../packages/database/src/index.ts";
import { Effect } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";

const paths: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

interface FixtureItem {
  readonly id: string;
  readonly libraryId: string;
  readonly title: string;
  readonly kind?: "movie" | "show" | "season" | "episode" | "track";
  readonly parentId?: string;
  readonly number?: number;
  readonly added?: number;
  readonly available?: boolean;
  readonly playable?: boolean;
  readonly position?: number;
  readonly completed?: boolean;
  readonly activity?: number;
}

const fixture = async (items: ReadonlyArray<FixtureItem>, allowed: ReadonlyArray<string>) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-home-"));
  paths.push(root);
  const databasePath = join(root, "catalog.sqlite");
  const userId = newUuid();
  const layer = makeDatabaseLayers({ databasePath } as never);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const password = yield* Effect.promise(() => hashPassword("correct horse battery staple"));
      yield* db.run(sql`INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${userId}, 'viewer', 'viewer', 'Viewer', ${password}, 'user', 1, 1, 1)`);
      for (const libraryId of new Set([...allowed, ...items.map((item) => item.libraryId)])) {
        const kind = items.some((item) => item.libraryId === libraryId && item.kind === "show")
          ? "shows"
          : items.some((item) => item.libraryId === libraryId && item.kind === "track")
            ? "music"
            : "movies";
        yield* db.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms)
        VALUES (${libraryId}, ${kind}, ${libraryId}, 1, 1, 1)`);
        yield* db.run(
          sql`INSERT INTO library_profiles(library_id, kind) VALUES (${libraryId}, ${kind})`,
        );
        yield* db.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms)
        VALUES (${libraryId}, ${libraryId}, ${join(root, libraryId)}, 1, 0, 1, 1)`);
        if (allowed.includes(libraryId))
          yield* db.run(sql`INSERT INTO library_grants(id, library_id, user_id, role, capabilities_json, created_at_ms, updated_at_ms)
        VALUES (${newUuid()}, ${libraryId}, ${userId}, 'user', '["library:read"]', 1, 1)`);
      }
      for (const item of items) {
        const kind = item.kind ?? "movie";
        yield* db.run(sql`INSERT INTO catalog_items(id, library_id, kind, parent_id, title, sort_title, index_number, duration_seconds, added_at_ms, updated_at_ms)
        VALUES (${item.id}, ${item.libraryId}, ${kind}, ${item.parentId ?? null}, ${item.title}, ${item.title.toLowerCase()}, ${item.number ?? null}, 1800, ${item.added ?? 1}, ${item.added ?? 1})`);
        if (!["show", "season"].includes(kind)) {
          yield* db.run(sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, scanned_at_ms)
          VALUES (${item.id}, ${item.libraryId}, ${item.libraryId}, ${item.id}, ${join(root, item.libraryId, item.id)}, 1)`);
          yield* db.run(
            sql`INSERT INTO catalog_item_sources(item_id, source_id, is_primary) VALUES (${item.id}, ${item.id}, 1)`,
          );
          if (item.playable !== false) {
            yield* db.run(
              sql`INSERT INTO streams(id, source_id, kind, ordinal) VALUES (${item.id}, ${item.id}, ${kind === "track" ? "audio" : "video"}, 0)`,
            );
            yield* db.run(sql`INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, created_at_ms, updated_at_ms)
              VALUES (${item.id}, ${item.libraryId}, ${item.id}, ${item.id}, ${item.title}, ${item.title.toLowerCase()}, 1, 1)`);
          }
          if (item.available === false)
            yield* db.run(
              sql`INSERT INTO media_source_availability(source_id, is_available, updated_at_ms) VALUES (${item.id}, 0, 1)`,
            );
        }
        if (item.position !== undefined || item.completed !== undefined)
          yield* db.run(sql`INSERT INTO item_watch_states(user_id, item_id, position_seconds, completed, updated_at_ms)
        VALUES (${userId}, ${item.id}, ${item.position ?? 0}, ${item.completed ? 1 : 0}, ${item.activity ?? Date.now()})`);
      }
    }).pipe(Effect.provide(layer)),
  );
  const running = await startServer({ databasePath, dataDir: root, host: "127.0.0.1", port: 0 });
  servers.push(running);
  const login = await fetch(new URL("/api/v1/auth/login", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "viewer",
      password: "correct horse battery staple",
      deviceId: newUuid(),
      deviceName: "Home test",
      platform: "desktop",
      platformDeviceId: null,
    }),
  });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const request = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, running.server.url), {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  return { request, base: running.server.url };
};

test("Home selects newest available movies across the catalog within the user's libraries", async () => {
  const libraryId = newUuid();
  const old = newUuid();
  const newest = newUuid();
  const home = await fixture(
    [
      { id: old, libraryId, title: "Alphabetically first", added: 1 },
      { id: newest, libraryId, title: "Z newest", added: 2 },
      { id: newUuid(), libraryId, title: "Watched", added: 3, completed: true },
      { id: newUuid(), libraryId, title: "Missing", added: 4, available: false },
      { id: newUuid(), libraryId: newUuid(), title: "Private", added: 5 },
      { id: newUuid(), libraryId, title: "Probe failed", added: 6, playable: false },
    ],
    [libraryId],
  );
  expect((await fetch(new URL("/api/v1/home", home.base))).status).toBe(401);
  const response = await home.request("/api/v1/home");
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.libraries.map((library: { id: string }) => library.id)).toEqual([libraryId]);
  expect(data.latest).toHaveLength(1);
  expect(data.latest[0].items.map((item: { id: string }) => item.id)).toEqual([newest, old]);
});

test("Continue rows include nested episodes and movies beyond the first browse page, ordered by activity", async () => {
  const libraryId = newUuid();
  const musicId = newUuid();
  const show = newUuid();
  const season = newUuid();
  const episode = newUuid();
  const movie = newUuid();
  const song = newUuid();
  const home = await fixture(
    [
      ...Array.from({ length: 60 }, (_, index) => ({
        id: newUuid(),
        libraryId,
        title: `A ${index}`,
      })),
      { id: movie, libraryId, title: "Z resume", position: 120, activity: 100 },
      { id: show, libraryId, title: "A show", kind: "show" },
      { id: season, libraryId, title: "Season 1", kind: "season", parentId: show, number: 1 },
      {
        id: episode,
        libraryId,
        title: "An episode",
        kind: "episode",
        parentId: season,
        number: 2,
        position: 300,
        activity: 200,
      },
      {
        id: newUuid(),
        libraryId,
        title: "Completed",
        position: 1790,
        completed: true,
        activity: 300,
      },
      {
        id: newUuid(),
        libraryId,
        title: "Unavailable",
        position: 30,
        available: false,
        activity: 400,
      },
      {
        id: newUuid(),
        libraryId: newUuid(),
        title: "Private progress",
        position: 30,
        activity: 500,
      },
      { id: song, libraryId: musicId, title: "Music", kind: "track", position: 40 },
    ],
    [libraryId, musicId],
  );
  const data = await (await home.request("/api/v1/home")).json();
  expect(data.continueWatching.map((item: { id: string }) => item.id)).toEqual([episode, movie]);
  expect(data.continueListening.map((item: { id: string }) => item.id)).toEqual([song]);
  expect(data.continueWatching[0]).toMatchObject({
    seriesTitle: "A show",
    seasonNumber: 1,
    indexNumber: 2,
  });
});

test("Next Up follows the furthest watched episode and moves in-progress episodes to Continue watching", async () => {
  const libraryId = newUuid();
  const show = newUuid();
  const season = newUuid();
  const secondSeason = newUuid();
  const next = newUuid();
  const later = newUuid();
  const never = newUuid();
  const stale = newUuid();
  const home = await fixture(
    [
      { id: show, libraryId, title: "Started show", kind: "show" },
      { id: season, libraryId, title: "Season 1", kind: "season", parentId: show, number: 1 },
      { id: secondSeason, libraryId, title: "Season 2", kind: "season", parentId: show, number: 2 },
      {
        id: newUuid(),
        libraryId,
        title: "Skipped gap",
        kind: "episode",
        parentId: season,
        number: 1,
      },
      {
        id: newUuid(),
        libraryId,
        title: "Watched",
        kind: "episode",
        parentId: season,
        number: 3,
        completed: true,
      },
      {
        id: newUuid(),
        libraryId,
        title: "Missing episode",
        kind: "episode",
        parentId: season,
        number: 4,
        available: false,
      },
      {
        id: next,
        libraryId,
        title: "Next episode",
        kind: "episode",
        parentId: secondSeason,
        number: 1,
      },
      {
        id: later,
        libraryId,
        title: "Later episode",
        kind: "episode",
        parentId: secondSeason,
        number: 2,
      },
      { id: never, libraryId, title: "Never started", kind: "show" },
      { id: newUuid(), libraryId, title: "Pilot", kind: "episode", parentId: never, number: 1 },
      { id: stale, libraryId, title: "Long forgotten", kind: "show" },
      {
        id: newUuid(),
        libraryId,
        title: "Old activity",
        kind: "episode",
        parentId: stale,
        number: 1,
        completed: true,
        activity: 1,
      },
      { id: newUuid(), libraryId, title: "Old next", kind: "episode", parentId: stale, number: 2 },
    ],
    [libraryId],
  );
  const getHome = async () => (await home.request("/api/v1/home")).json();
  expect((await getHome()).nextUp.map((item: { id: string }) => item.id)).toEqual([next]);
  expect(
    (
      await home.request(`/api/v1/items/${next}/watch-state`, {
        method: "PUT",
        body: JSON.stringify({ positionSeconds: 180, completed: false }),
      })
    ).status,
  ).toBe(200);
  expect((await getHome()).nextUp).toEqual([]);
  expect((await getHome()).continueWatching.map((item: { id: string }) => item.id)).toEqual([next]);
  expect(
    (
      await home.request(`/api/v1/items/${next}/watch-state`, {
        method: "PUT",
        body: JSON.stringify({ positionSeconds: 1800, completed: true }),
      })
    ).status,
  ).toBe(200);
  expect((await getHome()).nextUp.map((item: { id: string }) => item.id)).toEqual([later]);
});

test("Home always uses default library ordering and filtering without preference endpoints", async () => {
  const first = newUuid();
  const second = newUuid();
  const music = newUuid();
  const home = await fixture(
    [
      { id: newUuid(), libraryId: first, title: "First resume", position: 200 },
      { id: newUuid(), libraryId: second, title: "Second resume", position: 200 },
      { id: newUuid(), libraryId: second, title: "Watched movie", completed: true, added: 5 },
      { id: newUuid(), libraryId: music, title: "Music resume", kind: "track", position: 200 },
    ],
    [music, second, first],
  );
  const content = await (await home.request("/api/v1/home")).json();
  const orderedIds = [...[first, second].sort(), music];
  expect(content.libraryCount).toBe(3);
  expect(content.libraries.map((library: { id: string }) => library.id)).toEqual(orderedIds);
  expect(content.latest.map((row: { libraryId: string }) => row.libraryId)).toEqual(orderedIds);
  expect(content.latest.every((row: { items: unknown[] }) => row.items.length === 1)).toBe(true);
  expect(content.continueWatching).toHaveLength(2);
  expect(content.continueListening).toHaveLength(1);
  expect(content).not.toHaveProperty("preferences");
  expect((await home.request("/api/v1/home/preferences")).status).toBe(404);
  expect(
    (
      await home.request("/api/v1/home/preferences", {
        method: "PUT",
        body: JSON.stringify({
          sections: [],
          libraryOrder: [music, second, first],
          hiddenLibraries: [first],
          excludedLibraries: [second],
          hideWatched: false,
          nextUpDays: 1,
        }),
      })
    ).status,
  ).toBe(404);
  expect(await (await home.request("/api/v1/home")).json()).toEqual(content);
});

test("Latest TV groups episode batches into seasons or shows and ranks by episode additions", async () => {
  const libraryId = newUuid();
  const day = 86400000;
  const items: FixtureItem[] = [];
  const makeShow = (title: string, seasons: ReadonlyArray<ReadonlyArray<number>>) => {
    const id = newUuid();
    const seasonIds: string[] = [];
    const episodeIds: string[][] = [];
    items.push({ id, libraryId, title, kind: "show", added: 1 });
    seasons.forEach((dates, seasonIndex) => {
      const seasonId = newUuid();
      seasonIds.push(seasonId);
      const episodes: string[] = [];
      episodeIds.push(episodes);
      items.push({
        id: seasonId,
        libraryId,
        title: `Season ${seasonIndex + 1}`,
        kind: "season",
        parentId: id,
        number: seasonIndex + 1,
      });
      dates.forEach((date, index) => {
        const episodeId = newUuid();
        episodes.push(episodeId);
        items.push({
          id: episodeId,
          libraryId,
          title: `Episode ${index + 1}`,
          kind: "episode",
          parentId: seasonId,
          number: index + 1,
          added: date * day,
        });
      });
    });
    return { id, seasonIds, episodeIds };
  };
  const single = makeShow("Weekly show", [[1, 11]]);
  const season = makeShow("New season", [[1], [10, 10]]);
  const whole = makeShow("Whole show", [[9], [9]]);
  const oneSeason = makeShow("Single season", [[7, 7]]);
  const home = await fixture(items, [libraryId]);
  const data = await (await home.request("/api/v1/home")).json();
  expect(data.latest).toHaveLength(1);
  expect(data.latest[0].items.map((item: { id: string }) => item.id)).toEqual([
    single.episodeIds[0]?.[1],
    season.seasonIds[1],
    whole.id,
    oneSeason.id,
  ]);
  expect(data.latest[0].items[1]).toMatchObject({ kind: "season", seriesTitle: "New season" });
});

test("The desktop client reads default Home with account-specific content and handles no library access", async () => {
  const libraryId = newUuid();
  const home = await fixture([{ id: newUuid(), libraryId, title: "A movie" }], [libraryId]);
  const client = new ServerClient({ origin: String(home.base) });
  await client.login(
    {
      origin: String(home.base),
      username: "viewer",
      password: "correct horse battery staple",
      serverLabel: "Test",
    },
    newUuid(),
  );
  expect((await client.home()).latest[0]?.items[0]?.title).toBe("A movie");
  const other = new ServerClient({ origin: String(home.base) });
  await other.register(
    {
      origin: String(home.base),
      username: "other",
      displayName: "Other",
      password: "correct horse battery staple",
      serverLabel: "Test",
    },
    newUuid(),
  );
  expect(await other.home()).toEqual({
    libraryCount: 0,
    libraries: [],
    continueWatching: [],
    continueListening: [],
    nextUp: [],
    latest: [],
  });
});

test("Home applies default row limits after filtering and includes watched music in Latest", async () => {
  const moviesId = newUuid();
  const musicId = newUuid();
  const showsId = newUuid();
  const items: FixtureItem[] = [];
  for (let index = 1; index <= 35; index++) {
    items.push({
      id: newUuid(),
      libraryId: moviesId,
      title: `Movie ${index}`,
      position: 100,
      activity: index,
      added: index,
    });
    items.push({
      id: newUuid(),
      libraryId: musicId,
      title: `Track ${index}`,
      kind: "track",
      completed: true,
      added: index,
    });
    const show = newUuid();
    items.push({ id: show, libraryId: showsId, title: `Show ${index}`, kind: "show" });
    items.push({
      id: newUuid(),
      libraryId: showsId,
      title: `Watched ${index}`,
      kind: "episode",
      parentId: show,
      number: 1,
      completed: true,
      activity: Date.now() - (36 - index) * 1000,
    });
    items.push({
      id: newUuid(),
      libraryId: showsId,
      title: `Next ${index}`,
      kind: "episode",
      parentId: show,
      number: 2,
    });
  }
  for (let index = 0; index < 20; index++)
    items.push({
      id: newUuid(),
      libraryId: moviesId,
      title: "Unavailable newest",
      added: 1000 + index,
      position: 200,
      activity: 1000 + index,
      available: false,
    });
  const home = await fixture(items, [moviesId, musicId, showsId]);
  const data = await (await home.request("/api/v1/home")).json();
  expect(data.continueWatching).toHaveLength(12);
  expect(data.continueWatching[0].title).toBe("Movie 35");
  expect(data.continueWatching[11].title).toBe("Movie 24");
  expect(data.nextUp).toHaveLength(24);
  expect(data.nextUp[0].title).toBe("Next 35");
  expect(data.nextUp[23].title).toBe("Next 12");
  const movies = data.latest.find((row: { libraryId: string }) => row.libraryId === moviesId);
  const music = data.latest.find((row: { libraryId: string }) => row.libraryId === musicId);
  expect(movies.items).toHaveLength(16);
  expect(movies.items[0].title).toBe("Movie 35");
  expect(music.items).toHaveLength(30);
  expect(music.items[0].title).toBe("Track 35");
});

test("desktop watched actions update whole seasons, clear resume, and preserve library access", async () => {
  const libraryId = newUuid();
  const show = newUuid();
  const season = newUuid();
  const otherSeason = newUuid();
  const nextEpisode = newUuid();
  const movie = newUuid();
  const privateMovie = newUuid();
  const episodes = Array.from({ length: 105 }, (_, index) => ({
    id: newUuid(),
    libraryId,
    title: `Episode ${index + 1}`,
    kind: "episode" as const,
    parentId: season,
    number: index + 1,
    position: 60,
  }));
  const home = await fixture(
    [
      { id: show, libraryId, title: "Show", kind: "show" },
      { id: season, libraryId, title: "Season 1", kind: "season", parentId: show, number: 1 },
      { id: otherSeason, libraryId, title: "Season 2", kind: "season", parentId: show, number: 2 },
      ...episodes,
      {
        id: nextEpisode,
        libraryId,
        title: "Next season",
        kind: "episode",
        parentId: otherSeason,
        number: 1,
      },
      { id: movie, libraryId, title: "Movie", position: 120 },
      { id: privateMovie, libraryId: newUuid(), title: "Private movie" },
    ],
    [libraryId],
  );
  const client = new ServerClient({ origin: String(home.base) });
  await client.login(
    {
      origin: String(home.base),
      username: "viewer",
      password: "correct horse battery staple",
      serverLabel: "Test server",
    },
    newUuid(),
  );

  await client.setWatched(season, true);
  expect((await client.itemDetails(season)).item.completed).toBe(true);
  const firstPage = await client.itemChildren(season);
  expect(firstPage.items).toHaveLength(100);
  expect(
    firstPage.items.every((item) => item.completed && item.resumePositionSeconds === null),
  ).toBe(true);
  const lastPage = await client.itemChildren(season, firstPage.nextCursor);
  expect(lastPage.items).toHaveLength(5);
  expect(
    lastPage.items.every((item) => item.completed && item.resumePositionSeconds === null),
  ).toBe(true);
  expect((await client.nextUp(show))?.id).toBe(nextEpisode);
  expect((await client.home()).continueWatching.map((item) => item.id)).toEqual([movie]);

  const episodeId = episodes[0]?.id ?? "";
  await client.setWatched(episodeId, false);
  expect((await client.itemDetails(season)).item.completed).toBe(false);
  expect(
    (await client.itemChildren(show)).items.find((item) => item.id === season)?.completed,
  ).toBe(false);
  await client.setWatched(episodeId, true);
  expect((await client.itemDetails(season)).item.completed).toBe(true);
  await client.setWatched(season, false);
  expect((await client.itemChildren(season)).items.every((item) => item.completed === false)).toBe(
    true,
  );
  expect((await client.nextUp(show))?.id).toBe(episodeId);

  await client.setWatched(movie, true);
  expect((await client.items(libraryId)).items.find((item) => item.id === movie)).toMatchObject({
    completed: true,
    resumePositionSeconds: null,
  });
  expect((await client.itemDetails(movie)).watchState).toEqual({
    completed: true,
    positionSeconds: 0,
  });
  expect((await client.home()).continueWatching).toEqual([]);
  await client.setWatched(movie, false);
  expect((await client.itemDetails(movie)).item.completed).toBe(false);
  await expect(client.setWatched(privateMovie, true)).rejects.toThrow();
  await expect(client.setWatched(newUuid(), true)).rejects.toThrow();
});
