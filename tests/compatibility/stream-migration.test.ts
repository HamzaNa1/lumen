import { afterEach, describe, expect, test } from "bun:test";
import { Database, DatabaseLive, migrateDatabase, sql } from "../../packages/database/src/index.ts";
import { Effect } from "../../packages/database/node_modules/effect/dist/index.js";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("stream migration", () => {
  test("upgrades existing tracks without cascading and permits repeated language streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-migration-test-"));
    paths.push(root);
    const legacyMigrations = join(root, "legacy-migrations");
    await mkdir(legacyMigrations);
    for (const name of ["20260923190603_famous_bloodstrike", "20260923193851_hot_loners", "20260923202056_green_the_hood"]) {
      await cp(join(process.cwd(), "packages/database/drizzle", name), join(legacyMigrations, name), { recursive: true });
    }
    const databasePath = join(root, "server.sqlite");
    const libraryId = newUuid();
    const rootId = newUuid();
    const sourceId = newUuid();
    const repairSourceId = newUuid();
    const videoId = newUuid();
    const audioId = newUuid();
    const subtitleId = newUuid();
    const trackId = newUuid();
    const itemId = newUuid();
    const runId = newUuid();
    const jobId = newUuid();

    await Effect.runPromise(migrateDatabase(legacyMigrations).pipe(Effect.provide(DatabaseLive({ filename: databasePath }))));
    await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      yield* database.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, 1, 1)`);
      yield* database.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`);
      yield* database.run(sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, scanned_at_ms) VALUES (${sourceId}, ${libraryId}, ${rootId}, 'Movie.mkv', ${join(root, "Movie.mkv")}, 'local', 1)`);
      yield* database.run(sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, scanned_at_ms) VALUES (${repairSourceId}, ${libraryId}, ${rootId}, 'Repair.mkv', ${join(root, "Repair.mkv")}, 'local', 1)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, is_default) VALUES (${videoId}, ${sourceId}, 'video', 0)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, is_default) VALUES (${newUuid()}, ${repairSourceId}, 'video', 0)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, language, is_default) VALUES (${audioId}, ${sourceId}, 'audio', 'eng', 1)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, language, is_default) VALUES (${subtitleId}, ${sourceId}, 'subtitle', 'eng', 0)`);
      yield* database.run(sql`INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, created_at_ms, updated_at_ms) VALUES (${trackId}, ${libraryId}, ${sourceId}, ${videoId}, 'Movie', 'movie', 1, 1)`);
      yield* database.run(sql`INSERT INTO catalog_items(id, library_id, kind, title, sort_title, metadata_state, added_at_ms, updated_at_ms) VALUES (${itemId}, ${libraryId}, 'movie', 'Movie', 'movie', 'local', 1, 1)`);
      yield* database.run(sql`INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (${itemId}, ${sourceId}, 1, 1)`);
      yield* database.run(sql`INSERT INTO scan_runs(id, library_id, mode, status) VALUES (${runId}, ${libraryId}, 'full', 'failed')`);
      yield* database.run(sql`INSERT INTO scan_jobs(id, run_id, source_id, dedupe_key, operation, status, attempts, max_attempts, available_at_ms, started_at_ms, finished_at_ms, error_code) VALUES (${jobId}, ${runId}, ${repairSourceId}, ${`probe:${repairSourceId}`}, 'probe', 'failed', 3, 3, 1, 1, 1, 'JOB_FAILED')`);
    }).pipe(Effect.provide(DatabaseLive({ filename: databasePath }))));

    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      yield* migrateDatabase();
      const track = yield* database.get<{ count: number }>(sql`SELECT count(*) AS count FROM tracks WHERE id = ${trackId}`);
      const item = yield* database.get<{ count: number }>(sql`SELECT count(*) AS count FROM catalog_items WHERE id = ${itemId}`);
      const streams = yield* database.all<{ id: string; ordinal: number | null }>(sql`SELECT id, ordinal FROM streams WHERE source_id = ${sourceId} ORDER BY id`);
      const job = yield* database.get<{ status: string }>(sql`SELECT status FROM scan_jobs WHERE id = ${jobId}`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, language, title, ordinal) VALUES (${newUuid()}, ${sourceId}, 'subtitle', 'eng', 'English (SDH)', 2)`);
      return { track, item, job, streams };
    }).pipe(Effect.provide(DatabaseLive({ filename: databasePath }))));

    expect(upgraded.track?.count).toBe(1);
    expect(upgraded.item?.count).toBe(1);
    expect(upgraded.job?.status).toBe("queued");
    expect(upgraded.streams).toEqual(expect.arrayContaining([
      { id: audioId, ordinal: null },
      { id: subtitleId, ordinal: null },
      { id: videoId, ordinal: null },
    ]));
  });
});
