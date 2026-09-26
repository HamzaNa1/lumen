import { afterEach, describe, expect, test } from "bun:test";
import {
  Database,
  Repositories,
  RepositoriesLive,
  sql,
} from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { JobService, JobServiceLive } from "../../apps/server/src/jobs/JobService";
import { LibraryWatcherLive } from "../../apps/server/src/jobs/LibraryWatcher";
import {
  ScheduledJobService,
  ScheduledJobServiceLiveWithConfig,
} from "../../apps/server/src/jobs/ScheduledJobService";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { MediaIngestLive } from "../../apps/server/src/media/MediaIngest";
import { AccessControlLive } from "../../apps/server/src/services/AccessControl";
import type { AuthPrincipal } from "../../apps/server/src/services/AuthService";
import { CatalogService, CatalogServiceLive } from "../../apps/server/src/services/CatalogService";
import { LibraryService, LibraryServiceLive } from "../../apps/server/src/services/LibraryService";
import { MetadataSettingsLive } from "../../apps/server/src/services/MetadataSettings";
import { Scanner, ScannerLive } from "../../apps/server/src/services/Scanner";

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const admin: AuthPrincipal = {
  user: {
    id: newUuid(),
    username: "admin",
    displayName: "Admin",
    role: "admin",
    isActive: true,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  sessionId: newUuid(),
  deviceId: newUuid(),
} as unknown as AuthPrincipal;

const fakeFfprobe = Layer.succeed(Ffprobe, {
  probe: () =>
    Effect.succeed({
      durationMs: 60_000,
      streams: [
        {
          kind: "video" as const,
          ordinal: 0,
          codec: "h264",
          bitrate: null,
          sampleRateHz: null,
          channels: null,
          width: 1920,
          height: 1080,
          language: null,
          title: null,
          isDefault: true,
        },
      ],
      tags: {},
    }),
});

const makeHarness = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lumen-reconcile-"));
  paths.push(workspace);
  const database = makeDatabaseLayers({ databasePath: join(workspace, "server.sqlite") } as never);
  const dependencies = Layer.mergeAll(database, RepositoriesLive(database));
  const access = AccessControlLive.pipe(Layer.provide(dependencies));
  const settings = MetadataSettingsLive.pipe(Layer.provide(dependencies));
  const scanner = ScannerLive.pipe(Layer.provide(dependencies));
  const ingest = MediaIngestLive.pipe(Layer.provide(Layer.mergeAll(dependencies, fakeFfprobe)));
  const jobs = JobServiceLive.pipe(
    Layer.provide(Layer.mergeAll(dependencies, scanner, ingest, settings)),
  );
  const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
  const catalog = CatalogServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const watcher = LibraryWatcherLive.pipe(Layer.provide(Layer.mergeAll(dependencies, libraries)));
  const dataDir = join(workspace, "data");
  const scheduler = ScheduledJobServiceLiveWithConfig({ dataDir } as never).pipe(
    Layer.provide(Layer.mergeAll(dependencies, watcher)),
  );
  const layer = Layer.mergeAll(
    dependencies,
    access,
    settings,
    scanner,
    jobs,
    libraries,
    catalog,
    scheduler,
  );
  const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(sql`
        INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
        VALUES (${admin.user.id}, 'admin', 'admin', 'Admin', 'unused', 'admin', 1, 1, 1)
      `);
    }),
  );

  const createLibrary = async (kind: "movies" | "shows" | "music") => {
    const libraryId = newUuid();
    const rootId = newUuid();
    const rootPath = join(workspace, `${kind}-${libraryId}`);
    await mkdir(rootPath, { recursive: true });
    await run(
      Effect.gen(function* () {
        const service = yield* LibraryService;
        yield* service.create({ id: libraryId, name: kind, slug: `${kind}-${libraryId}`, kind }, 1);
        yield* service.addRoot({ id: rootId, libraryId, path: rootPath, priority: 0 }, 1);
      }),
    );
    const file = async (relativePath: string) => {
      const path = join(rootPath, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "media");
      return path;
    };
    return { libraryId, rootId, rootPath, file };
  };

  const scan = (libraryId: string) =>
    run(
      Effect.gen(function* () {
        const service = yield* LibraryService;
        const worker = yield* JobService;
        const started = yield* service.startScan({ libraryId, mode: "full" }, Date.now());
        while (yield* worker.runOne(Date.now())) {}
        return started.runId;
      }),
    );

  const browse = (libraryId: string) =>
    run(
      Effect.gen(function* () {
        const catalog = yield* CatalogService;
        const page = yield* catalog.listItems(admin, libraryId, { limit: 100 }, Date.now());
        return page.items as ReadonlyArray<{ id: string; title: string; kind: string }>;
      }),
    );

  const children = (itemId: string) =>
    run(
      Effect.gen(function* () {
        const catalog = yield* CatalogService;
        const page = yield* catalog.listItemChildren(admin, itemId, { limit: 100 }, Date.now());
        return page.items as ReadonlyArray<{ id: string; title: string; kind: string }>;
      }),
    );

  const search = (q: string) =>
    run(
      Effect.gen(function* () {
        const catalog = yield* CatalogService;
        const page = yield* catalog.searchItems(
          admin,
          { q, libraryId: null, limit: 100 },
          Date.now(),
        );
        return (page.items as ReadonlyArray<{ title: string }>).map((item) => item.title);
      }),
    );

  const query = <T>(statement: ReturnType<typeof sql>) =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.all<T>(statement);
      }),
    );

  const foreignKeyViolations = () => query<unknown>(sql`PRAGMA foreign_key_check`);

  return {
    workspace,
    dataDir,
    run,
    createLibrary,
    scan,
    browse,
    children,
    search,
    query,
    foreignKeyViolations,
  };
};

describe("media reconciliation", () => {
  test("a file removed from a reachable root disappears from browse and search after the next scan", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Kept Movie (2020)/Kept Movie (2020).mkv");
    const removed = await movies.file("Gone Movie (2021)/Gone Movie (2021).mkv");
    await harness.scan(movies.libraryId);
    expect((await harness.browse(movies.libraryId)).map((item) => item.title).sort()).toEqual([
      "Gone Movie",
      "Kept Movie",
    ]);

    await rm(removed);
    await harness.scan(movies.libraryId);

    expect((await harness.browse(movies.libraryId)).map((item) => item.title)).toEqual([
      "Kept Movie",
    ]);
    expect(await harness.search("Gone")).toEqual([]);
    expect(await harness.search("Kept")).toEqual(["Kept Movie"]);
    const sources = await harness.query<{ relativePath: string }>(
      sql`SELECT relative_path AS relativePath FROM media_sources`,
    );
    expect(sources.map((source) => source.relativePath)).toEqual([
      "Kept Movie (2020)/Kept Movie (2020).mkv",
    ]);
    const orphanedStreams = await harness.query<{ count: number }>(
      sql`SELECT count(*) AS count FROM streams WHERE source_id NOT IN (SELECT id FROM media_sources)`,
    );
    expect(orphanedStreams[0]?.count).toBe(0);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("empty seasons and shows are pruned while populated ones keep their artwork", async () => {
    const harness = await makeHarness();
    const shows = await harness.createLibrary("shows");
    await shows.file("House/Season 1/House S01E01.mkv");
    const seasonTwo = await shows.file("House/Season 2/House S02E01.mkv");
    const other = await shows.file("Other/Season 1/Other S01E01.mkv");
    await writeFile(join(shows.rootPath, "House", "poster.png"), png(4, 6));
    await writeFile(join(shows.rootPath, "Other", "poster.png"), png(4, 6));
    await harness.scan(shows.libraryId);

    await rm(seasonTwo);
    await rm(other);
    await harness.scan(shows.libraryId);

    const remaining = await harness.browse(shows.libraryId);
    expect(remaining.map((item) => item.title)).toEqual(["House"]);
    const house = remaining[0];
    if (house === undefined) throw new Error("Expected House to remain");
    expect((await harness.children(house.id)).map((item) => item.title)).toEqual(["Season 1"]);
    expect(await harness.search("Other")).toEqual([]);
    const posters = await harness.query<{ itemId: string; path: string }>(sql`
      SELECT catalog_item_artwork.item_id AS itemId, artwork.relative_path AS path
      FROM catalog_item_artwork JOIN artwork ON artwork.id = catalog_item_artwork.artwork_id
    `);
    expect(
      posters.map((poster) => [poster.itemId, poster.path.endsWith("House/poster.png")]),
    ).toEqual([[house.id, true]]);
    const artworkRows = await harness.query<{ path: string; sourceExists: number }>(sql`
      SELECT relative_path AS path,
        source_id IN (SELECT id FROM media_sources) AS sourceExists
      FROM artwork
    `);
    expect(artworkRows).toEqual([
      { path: expect.stringMatching(/House\/poster\.png$/u), sourceExists: 1 },
    ]);
    const items = await harness.query<{ count: number }>(
      sql`SELECT count(*) AS count FROM catalog_items WHERE library_id = ${shows.libraryId}`,
    );
    expect(items[0]?.count).toBe(3);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("removing the primary source of a multi-source item keeps the item on a remaining source", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    const primary = await movies.file("Film (2020)/Film (2020).mkv");
    await movies.file("Film (2020) 4K/Film (2020).mkv");
    await harness.scan(movies.libraryId);
    const [item, duplicate] = await harness.query<{ id: string; sourceId: string }>(sql`
      SELECT catalog_items.id AS id, catalog_item_sources.source_id AS sourceId
      FROM catalog_items JOIN catalog_item_sources ON catalog_item_sources.item_id = catalog_items.id
      JOIN media_sources ON media_sources.id = catalog_item_sources.source_id
      ORDER BY media_sources.relative_path = 'Film (2020)/Film (2020).mkv' DESC
    `);
    if (item === undefined || duplicate === undefined) throw new Error("Expected two movies");
    await harness.query(sql`
      UPDATE catalog_item_sources SET item_id = ${item.id}, is_primary = 0
      WHERE source_id = ${duplicate.sourceId}
    `);
    await harness.query(sql`DELETE FROM catalog_items WHERE id = ${duplicate.id}`);

    await rm(primary);
    await harness.scan(movies.libraryId);

    expect((await harness.browse(movies.libraryId)).map((row) => row.id)).toEqual([item.id]);
    const links = await harness.query<{ sourceId: string; isPrimary: number }>(sql`
      SELECT source_id AS sourceId, is_primary AS isPrimary FROM catalog_item_sources
      WHERE item_id = ${item.id}
    `);
    expect(links).toEqual([{ sourceId: duplicate.sourceId, isPrimary: 1 }]);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("albums and artists left without tracks are pruned from the catalog and search index", async () => {
    const harness = await makeHarness();
    const music = await harness.createLibrary("music");
    await music.file("Band/Kept Album/01 Stay.flac");
    const gone = await music.file("Band/Gone Album/01 Leave.flac");
    const solo = await music.file("Soloist/Only Album/01 Alone.flac");
    await writeFile(join(music.rootPath, "Soloist", "Only Album", "01 Alone.png"), png(2, 2));
    await harness.scan(music.libraryId);

    await rm(gone);
    await rm(solo);
    await harness.scan(music.libraryId);

    const albums = await harness.query<{ title: string }>(sql`SELECT title FROM albums`);
    expect(albums.map((album) => album.title)).toEqual(["Kept Album"]);
    const artists = await harness.query<{ name: string }>(sql`SELECT name FROM artists`);
    expect(artists.map((artist) => artist.name)).toEqual(["Band"]);
    const indexed = await harness.query<{ title: string }>(
      sql`SELECT title FROM catalog_fts ORDER BY entity_type, title`,
    );
    expect(indexed.map((row) => row.title)).toEqual(["Kept Album", "Band", "01 Stay"]);
    const artwork = await harness.query<{ count: number }>(
      sql`SELECT count(*) AS count FROM artwork`,
    );
    expect(artwork[0]?.count).toBe(0);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("removals larger than one purge batch are fully reconciled", async () => {
    const harness = await makeHarness();
    const shows = await harness.createLibrary("shows");
    await shows.file("House/Season 2/House S02E01.mkv");
    for (let episode = 1; episode <= 600; episode += 1)
      await shows.file(`House/Season 1/House S01E${String(episode).padStart(3, "0")}.mkv`);
    await harness.scan(shows.libraryId);

    await rm(join(shows.rootPath, "House", "Season 1"), { recursive: true });
    await harness.scan(shows.libraryId);

    const [house] = await harness.browse(shows.libraryId);
    if (house === undefined) throw new Error("Expected House to remain");
    expect((await harness.children(house.id)).map((item) => item.title)).toEqual(["Season 2"]);
    const sources = await harness.query<{ count: number }>(
      sql`SELECT count(*) AS count FROM media_sources`,
    );
    expect(sources[0]?.count).toBe(1);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  }, 60_000);

  test("an unreachable root keeps its catalog and is marked unavailable", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Film (2020)/Film (2020).mkv");
    await harness.scan(movies.libraryId);

    await rename(movies.rootPath, `${movies.rootPath}-offline`);
    await harness.scan(movies.libraryId);

    expect((await harness.browse(movies.libraryId)).map((item) => item.title)).toEqual(["Film"]);
    const state = await harness.query<{ isAvailable: number }>(
      sql`SELECT is_available AS isAvailable FROM library_root_states WHERE root_id = ${movies.rootId}`,
    );
    expect(state).toEqual([{ isAvailable: 0 }]);
  });

  test("a previously indexed root that now reads as empty is treated as unmounted", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    const film = await movies.file("Film (2020)/Film (2020).mkv");
    await harness.scan(movies.libraryId);

    await rm(dirname(film), { recursive: true });
    await harness.scan(movies.libraryId);

    expect((await harness.browse(movies.libraryId)).map((item) => item.title)).toEqual(["Film"]);
    const state = await harness.query<{ isAvailable: number; reason: string | null }>(sql`
      SELECT is_available AS isAvailable, unavailable_reason AS reason
      FROM library_root_states WHERE root_id = ${movies.rootId}
    `);
    expect(state).toEqual([{ isAvailable: 0, reason: "EMPTY" }]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a root that can only be partially read deletes nothing",
    async () => {
      const harness = await makeHarness();
      const movies = await harness.createLibrary("movies");
      await movies.file("Film (2020)/Film (2020).mkv");
      await movies.file("Locked (2021)/Locked (2021).mkv");
      await harness.scan(movies.libraryId);

      const locked = join(movies.rootPath, "Locked (2021)");
      await chmod(locked, 0o000);
      try {
        await harness.scan(movies.libraryId);
      } finally {
        await chmod(locked, 0o755);
      }

      expect((await harness.browse(movies.libraryId)).map((item) => item.title).sort()).toEqual([
        "Film",
        "Locked",
      ]);
    },
  );

  test("a cleanup left over from a superseded scan deletes nothing", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    const removed = await movies.file("Film (2020)/Film (2020).mkv");
    await movies.file("Other (2021)/Other (2021).mkv");
    await harness.scan(movies.libraryId);

    await rm(removed);
    const staleCleanup = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const repositories = yield* Repositories;
        const worker = yield* JobService;
        const stale = yield* libraries.startScan(
          { libraryId: movies.libraryId, mode: "full" },
          Date.now(),
        );
        yield* worker.runOne(Date.now());
        // The run is abandoned and a newer scan claims the root before its cleanup runs.
        yield* repositories.scanning.finishRun({
          runId: stale.runId,
          status: "failed",
          nowMs: Date.now(),
          errorCode: "JOB_FAILED",
          errorMessage: "A scan job exhausted its retries",
        });
        yield* libraries.startScan({ libraryId: movies.libraryId, mode: "full" }, Date.now());
        const jobs = yield* repositories.scanning.listJobs({ runId: stale.runId });
        const cleanup = jobs.find((job) => job.operation === "cleanup");
        if (cleanup === undefined) throw new Error("Expected the stale run to queue a cleanup");
        while ((yield* repositories.scanning.getJob({ id: cleanup.id })).status === "queued")
          yield* worker.runOne(Date.now());
        return yield* repositories.scanning.getJob({ id: cleanup.id });
      }),
    );

    expect(staleCleanup.status).toBe("succeeded");
    expect((await harness.browse(movies.libraryId)).map((item) => item.title)).toEqual([
      "Film",
      "Other",
    ]);
  });

  test("re-running a completed cleanup is a no-op", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Kept (2020)/Kept (2020).mkv");
    const removed = await movies.file("Gone (2021)/Gone (2021).mkv");
    await harness.scan(movies.libraryId);
    await rm(removed);
    const runId = await harness.scan(movies.libraryId);

    const repeated = await harness.run(
      Effect.gen(function* () {
        const scanner = yield* Scanner;
        const db = yield* Database;
        const state = yield* db.get<{ generation: number }>(
          sql`SELECT scan_generation AS generation FROM library_root_states WHERE root_id = ${movies.rootId}`,
        );
        return yield* scanner.cleanup(runId, movies.rootId, state?.generation ?? null);
      }),
    );

    expect(repeated).toMatchObject({ skipped: null, sourcesDeleted: 0, itemsDeleted: 0 });
    expect((await harness.browse(movies.libraryId)).map((item) => item.title)).toEqual(["Kept"]);
  });
});

describe("library deletion", () => {
  test("removes every catalog, search, playback and job record owned by the library", async () => {
    const harness = await makeHarness();
    const shows = await harness.createLibrary("shows");
    await shows.file("House/Season 1/House S01E01.mkv");
    await writeFile(join(shows.rootPath, "House", "poster.png"), png(4, 6));
    const music = await harness.createLibrary("music");
    await music.file("Band/Album/01 Song.flac");
    await writeFile(join(music.rootPath, "Band", "Album", "01 Song.png"), png(2, 2));
    const kept = await harness.createLibrary("movies");
    await kept.file("Kept (2020)/Kept (2020).mkv");
    for (const library of [shows, music, kept]) await harness.scan(library.libraryId);
    const [show] = await harness.browse(shows.libraryId);
    const [song] = await harness.browse(music.libraryId);
    if (show === undefined || song === undefined) throw new Error("Expected indexed media");
    await harness.run(
      Effect.gen(function* () {
        const catalog = yield* CatalogService;
        yield* catalog.setItemFavorite(admin, song.id, { isFavorite: true }, Date.now());
        yield* catalog.setItemWatchState(
          admin,
          song.id,
          { positionSeconds: 10, completed: false },
          Date.now(),
        );
      }),
    );

    for (const library of [shows, music])
      await harness.run(
        Effect.gen(function* () {
          const libraries = yield* LibraryService;
          yield* libraries.remove(library.libraryId);
        }),
      );

    const deleted = [shows.libraryId, music.libraryId];
    for (const table of [
      "catalog_items",
      "media_sources",
      "artwork",
      "albums",
      "artists",
      "tracks",
      "scan_runs",
      "library_roots",
      "library_root_states",
      "library_profiles",
      "catalog_item_fts",
    ]) {
      const rows = await harness.query<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${sql.identifier(table)} WHERE library_id IN (${sql.join(deleted, sql`, `)})`,
      );
      expect({ table, count: rows[0]?.count }).toEqual({ table, count: 0 });
    }
    const staleSearch = await harness.query<{ count: number }>(sql`
      SELECT count(*) AS count FROM catalog_fts
      WHERE entity_id NOT IN (SELECT id FROM tracks UNION SELECT id FROM albums UNION SELECT id FROM artists)
    `);
    expect(staleSearch[0]?.count).toBe(0);
    for (const table of ["item_favorites", "item_watch_states", "server_scan_seen", "streams"]) {
      const rows = await harness.query<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`,
      );
      expect({ table, count: rows[0]?.count }).toEqual({
        table,
        count: table === "streams" ? 1 : table === "server_scan_seen" ? 1 : 0,
      });
    }
    expect(await harness.search("House")).toEqual([]);
    expect(await harness.search("Song")).toEqual([]);
    const details = await harness.run(
      Effect.gen(function* () {
        const catalog = yield* CatalogService;
        return yield* Effect.exit(catalog.itemDetails(admin, show.id, false, Date.now()));
      }),
    );
    expect(details._tag).toBe("Failure");
    expect((await harness.browse(kept.libraryId)).map((item) => item.title)).toEqual(["Kept"]);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("removing a root removes the catalog it contributed and keeps other roots", async () => {
    const harness = await makeHarness();
    const shows = await harness.createLibrary("shows");
    await shows.file("House/Season 1/House S01E01.mkv");
    const secondRootId = newUuid();
    const secondRoot = `${shows.rootPath}-second`;
    await mkdir(join(secondRoot, "Other", "Season 1"), { recursive: true });
    await writeFile(join(secondRoot, "Other", "Season 1", "Other S01E01.mkv"), "media");
    await writeFile(join(secondRoot, "Other", "poster.png"), png(4, 6));
    await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        yield* libraries.addRoot(
          { id: secondRootId, libraryId: shows.libraryId, path: secondRoot, priority: 1 },
          Date.now(),
        );
      }),
    );
    await harness.scan(shows.libraryId);

    await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        yield* libraries.deleteRoot(secondRootId);
      }),
    );

    expect((await harness.browse(shows.libraryId)).map((item) => item.title)).toEqual(["House"]);
    expect(await harness.search("Other")).toEqual([]);
    const artwork = await harness.query<{ count: number }>(
      sql`SELECT count(*) AS count FROM artwork`,
    );
    expect(artwork[0]?.count).toBe(0);
    expect(await harness.foreignKeyViolations()).toEqual([]);
  });

  test("generated artwork owned only by the deleted library is swept from disk", async () => {
    const harness = await makeHarness();
    const removed = await harness.createLibrary("movies");
    await removed.file("Gone (2020)/Gone (2020).mkv");
    const kept = await harness.createLibrary("movies");
    await kept.file("Kept (2020)/Kept (2020).mkv");
    for (const library of [removed, kept]) await harness.scan(library.libraryId);
    const [gone] = await harness.browse(removed.libraryId);
    const [stays] = await harness.browse(kept.libraryId);
    if (gone === undefined || stays === undefined) throw new Error("Expected indexed media");
    const artworkDir = join(harness.dataDir, "artwork");
    await mkdir(artworkDir, { recursive: true });
    const generated = (name: string) => join(artworkDir, `${name.repeat(64)}.png`);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const name of ["a", "b", "c"]) {
      await writeFile(generated(name), png(4, 6));
      await utimes(generated(name), longAgo, longAgo);
    }
    await writeFile(generated("d"), png(4, 6));
    const attach = (libraryId: string, itemId: string, name: string, role: string) =>
      harness
        .query(sql`
        WITH inserted AS (SELECT ${newUuid()} AS id)
        INSERT INTO artwork(id, library_id, source_id, kind, mime_type, width, height, byte_size, content_hash, relative_path)
        SELECT id, ${libraryId}, NULL, 'other', 'image/png', 4, 6, 24, ${name.repeat(64)}, ${generated(name)} FROM inserted
      `)
        .then(() =>
          harness.query(sql`
          INSERT INTO catalog_item_artwork(item_id, role, artwork_id, source)
          SELECT ${itemId}, ${role}, id, 'tmdb' FROM artwork
          WHERE library_id = ${libraryId} AND relative_path = ${generated(name)}
        `),
        );
    await attach(removed.libraryId, gone.id, "a", "poster");
    await attach(removed.libraryId, gone.id, "b", "backdrop");
    await attach(kept.libraryId, stays.id, "b", "poster");

    await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        yield* libraries.remove(removed.libraryId);
      }),
    );
    const swept = await harness.run(
      Effect.gen(function* () {
        const scheduler = yield* ScheduledJobService;
        return yield* scheduler.runDue(Date.now());
      }),
    );

    expect(swept).toBeGreaterThan(0);
    expect((await readdir(artworkDir)).sort()).toEqual(
      ["b", "d"].map((name) => `${name.repeat(64)}.png`),
    );
  });
});

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};
