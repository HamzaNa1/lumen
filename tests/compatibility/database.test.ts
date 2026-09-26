import { describe, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { Effect } from "../../packages/database/node_modules/effect/dist/index.js";
import {
  Database,
  DatabaseWithMigrationsLive,
  makeDatabaseRepositories,
  sql,
} from "../../packages/database/src/index.ts";
import { digests, fixtures, ids, times } from "../../packages/testkit/src/index.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, Database>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(DatabaseWithMigrationsLive({ filename: ":memory:" }))),
  );

describe("native Effect and Drizzle SQLite compatibility", () => {
  test("applies the complete physical migration with foreign keys and FTS5", async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const database = yield* Database;
        const tables = yield* database.all<{ name: string }>(sql`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
          ORDER BY name
        `);
        const foreignKeys = yield* database.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
        const migrations = yield* database.get<{ count: number }>(sql`
          SELECT count(*) AS count FROM __drizzle_migrations
        `);
        const fts = yield* database.get<{ value: number }>(sql`
          SELECT sqlite_compileoption_used('ENABLE_FTS5') AS value
        `);
        return { tables, foreignKeys, migrations, fts };
      }),
    );

    expect(result.foreignKeys?.foreign_keys).toBe(1);
    expect(result.migrations?.count).toBe(5);
    expect(result.fts?.value).toBe(1);
    expect(result.tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "album_artists",
        "albums",
        "artists",
        "artwork",
        "auth_sessions",
        "catalog_item_fts",
        "catalog_fts",
        "chapters",
        "devices",
        "favorites",
        "library_grants",
        "library_roots",
        "libraries",
        "media_sources",
        "metadata_provider_settings",
        "outbox_events",
        "playback_grants",
        "playback_progress",
        "playback_sessions",
        "refresh_tokens",
        "scan_jobs",
        "scan_runs",
        "server_event_log",
        "server_identity",
        "server_library_watch_state",
        "server_playback_sequences",
        "server_scan_missing",
        "server_scan_seen",
        "server_scheduled_jobs",
        "stream_sidecars",
        "streams",
        "track_artists",
        "track_metadata",
        "tracks",
        "users",
        "watch_states",
      ]),
    );
  });

  test("upgrades existing missing statistics and retains them until their library is deleted", () => {
    const database = new SqliteDatabase(":memory:");
    const applyMigration = (name: string) =>
      database.exec(
        readFileSync(
          new URL(`../../packages/database/drizzle/${name}/migration.sql`, import.meta.url),
          "utf8",
        ),
      );
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const name of [
        "20260925092802_shiny_killmonger",
        "20260925210556_library_watcher_job",
        "20260925210740_incremental_scan_stats",
      ])
        applyMigration(name);
      database.exec(`
        INSERT INTO libraries(id, name, slug, created_at_ms, updated_at_ms)
        VALUES ('library', 'Movies', 'movies', 1, 1);
        INSERT INTO library_roots(id, library_id, path, created_at_ms, updated_at_ms)
        VALUES ('root', 'library', '/media', 1, 1);
        INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, scanned_at_ms)
        VALUES ('source', 'library', 'root', 'gone.mkv', '/media/gone.mkv', 1);
        INSERT INTO scan_runs(id, library_id, mode, created_at_ms)
        VALUES ('run', 'library', 'incremental', 1);
        INSERT INTO server_scan_missing(run_id, source_id, missing_at_ms)
        VALUES ('run', 'source', 2);
      `);
      applyMigration("20260926085654_preserve_missing_scan_stats");
      database.exec("DELETE FROM media_sources WHERE id = 'source'");
      expect(database.query("SELECT * FROM server_scan_missing").all()).toEqual([
        { run_id: "run", source_id: "source", missing_at_ms: 2 },
      ]);
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      database.exec("DELETE FROM libraries WHERE id = 'library'");
      expect(database.query("SELECT * FROM server_scan_missing").all()).toEqual([]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("persists deterministic repository fixtures and searches FTS5", async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const database = yield* Database;
        const repositories = yield* makeDatabaseRepositories(database);
        const user = yield* repositories.auth.createUser(fixtures.createUser);
        const device = yield* repositories.auth.createDevice(fixtures.createDevice);
        const session = yield* repositories.auth.createSession({
          id: ids.authSession,
          userId: user.id,
          deviceId: device.id,
          sessionTokenHash: digests.session,
          issuedAtMs: times.epochMs,
          expiresAtMs: times.epochMs + times.hourMs,
        });
        const library = yield* repositories.libraries.create(fixtures.createLibrary);
        yield* repositories.libraries.addRoot({
          id: ids.libraryRoot,
          libraryId: library.id,
          path: "/media/main",
          priority: 0,
          nowMs: times.epochMs,
        });
        const grant = yield* repositories.libraries.upsertGrant({
          id: ids.libraryGrant,
          libraryId: library.id,
          userId: user.id,
          role: "admin",
          capabilities: ["library:read", "playback:control", "favorites:write"],
          canDownload: true,
          expiresAtMs: null,
          nowMs: times.epochMs,
        });
        const source = yield* repositories.catalog.createSource(fixtures.createSource);
        const stream = yield* repositories.catalog.createStream(fixtures.createStream);
        const chapter = yield* repositories.catalog.createChapter({
          id: ids.chapter,
          streamId: stream.id,
          ordinal: 0,
          title: "Opening",
          startMs: 0,
          endMs: 30_000,
        });
        const sidecar = yield* repositories.catalog.createSidecar({
          id: ids.sidecar,
          streamId: stream.id,
          kind: "lyrics",
          relativePath: "Track.lrc",
          mediaType: "text/plain",
          contentHash: digests.sidecar,
        });
        const artist = yield* repositories.catalog.upsertArtist(fixtures.createArtist);
        const album = yield* repositories.catalog.upsertAlbum(fixtures.createAlbum);
        const track = yield* repositories.catalog.createTrack(fixtures.createTrack);
        yield* repositories.catalog.attachArtist({
          trackId: track.id,
          artistId: artist.id,
          ordinal: 0,
          role: "primary",
        });
        const metadata = yield* repositories.catalog.upsertMetadata({
          trackId: track.id,
          namespace: "core",
          key: "replaygain",
          value: { trackGain: -7.2 },
          language: null,
          sourceId: source.id,
          nowMs: times.epochMs,
        });
        const artwork = yield* repositories.catalog.upsertArtwork({
          id: ids.artwork,
          libraryId: library.id,
          sourceId: source.id,
          kind: "front",
          mimeType: "image/jpeg",
          width: 600,
          height: 600,
          byteSize: 12_345,
          contentHash: digests.artwork,
          relativePath: "cover.jpg",
          nowMs: times.epochMs,
        });
        const assignment = yield* repositories.catalog.assignArtwork({
          artworkId: artwork.id,
          albumId: album.id,
          artistId: null,
          trackId: null,
          ordinal: 0,
          isPrimary: true,
        });
        const watchState = yield* repositories.activity.upsertWatchState({
          id: ids.watchState,
          userId: user.id,
          trackId: track.id,
          positionMs: 12_000,
          completed: false,
          nowMs: times.epochMs,
        });
        const favorite = yield* repositories.activity.setFavorite({
          userId: user.id,
          trackId: track.id,
          isFavorite: true,
          nowMs: times.epochMs,
        });
        const favoriteAgain = yield* repositories.activity.setFavorite({
          userId: user.id,
          trackId: track.id,
          isFavorite: true,
          nowMs: times.epochMs + times.minuteMs,
        });
        const playback = yield* repositories.activity.startPlayback({
          sessionId: ids.playbackSession,
          userId: user.id,
          deviceId: device.id,
          grantTokenHash: digests.playbackGrant,
          activeTrackId: track.id,
          nowMs: times.epochMs,
          expiresAtMs: times.epochMs + times.hourMs,
        });
        const playbackGrant = yield* repositories.activity.upsertGrant({
          id: ids.playbackGrant,
          sessionId: playback.id,
          trackId: track.id,
          canSeek: true,
          canSkip: false,
          maxBitrateKbps: 1_920,
          expiresAtMs: times.epochMs + times.hourMs,
        });
        const progress = yield* repositories.activity.updateProgress({
          sessionId: playback.id,
          trackId: track.id,
          positionMs: 15_000,
          durationMs: track.durationMs,
          nowMs: times.epochMs,
        });
        const run = yield* repositories.scanning.startRun({
          runId: ids.scanRun,
          libraryId: library.id,
          mode: "incremental",
          startedAtMs: times.epochMs,
        });
        const job = yield* repositories.scanning.createJob({
          id: ids.scanJob,
          runId: run.id,
          parentJobId: null,
          sourceId: source.id,
          dedupeKey: `probe:${source.id}`,
          operation: "probe",
          priority: 500,
          maxAttempts: 3,
          availableAtMs: times.epochMs,
        });
        const claimedJob = yield* repositories.scanning.claimNextJob({
          workerId: "worker-1",
          nowMs: times.epochMs,
          operations: ["probe"],
        });
        const outbox = yield* repositories.scanning.enqueueOutbox({
          id: ids.outboxEvent,
          aggregateType: "track",
          aggregateId: track.id,
          eventType: "track.changed",
          payloadJson: JSON.stringify({ trackId: track.id }),
          availableAtMs: times.epochMs,
        });
        const search = yield* repositories.search.search({
          query: "Deterministic",
          libraryId: library.id,
          limit: 10,
          offset: 0,
        });
        return {
          session,
          grant,
          chapter,
          sidecar,
          metadata,
          assignment,
          watchState,
          favorite,
          favoriteAgain,
          playbackGrant,
          progress,
          job,
          claimedJob,
          outbox,
          search,
        };
      }),
    );

    expect(result.session.id).toBe(ids.authSession);
    expect(result.grant.capabilities).toContain("playback:control");
    expect(result.chapter.endMs).toBe(30_000);
    expect(result.sidecar.kind).toBe("lyrics");
    expect(result.metadata.valueJson).toBe('{"trackGain":-7.2}');
    expect(result.assignment.albumId).toBe(ids.album);
    expect(result.watchState.positionMs).toBe(12_000);
    expect(result.favorite?.trackId).toBe(ids.track);
    expect(result.favoriteAgain?.trackId).toBe(ids.track);
    expect(result.playbackGrant.maxBitrateKbps).toBe(1_920);
    expect(result.progress.positionMs).toBe(15_000);
    expect(result.job.status).toBe("queued");
    expect(result.claimedJob?.id).toBe(ids.scanJob);
    expect(result.claimedJob?.attempts).toBe(1);
    expect(result.outbox.status).toBe("pending");
    expect(result.search.map((entry) => entry.entityId)).toEqual(
      expect.arrayContaining([ids.album, ids.track]),
    );
  });

  test("enforces physical checks and foreign keys", async () => {
    const failures = await withDatabase(
      Effect.gen(function* () {
        const database = yield* Database;
        const checkFailure = yield* Effect.exit(
          database.run(sql`
          INSERT INTO libraries(id, name, slug, created_at_ms, updated_at_ms)
          VALUES ('00000000-0000-4000-8000-000000000099', 'Bad', 'Bad', 1, 0)
        `),
        );
        const foreignKeyFailure = yield* Effect.exit(
          database.run(sql`
          INSERT INTO devices(id, user_id, name, platform, last_seen_at_ms, created_at_ms)
          VALUES (
            '00000000-0000-4000-8000-000000000098',
            '00000000-0000-4000-8000-000000000097',
            'Orphan',
            'web',
            1,
            1
          )
        `),
        );
        return { checkFailure, foreignKeyFailure };
      }),
    );

    expect(failures.checkFailure._tag).toBe("Failure");
    expect(failures.foreignKeyFailure._tag).toBe("Failure");
  });
});
