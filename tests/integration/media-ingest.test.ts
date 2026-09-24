import { afterEach, describe, expect, test } from "bun:test";
import { Database, DatabaseWithMigrationsLive, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { makeMediaIngest } from "../../apps/server/src/media/MediaIngest";

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("media ingest", () => {
  test("persists multiple streams with the same kind and language", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-ingest-test-"));
    paths.push(root);
    const mediaPath = join(root, "Movie.mkv");
    await writeFile(mediaPath, "media");
    const databaseLayer = DatabaseWithMigrationsLive({ filename: join(root, "ingest.sqlite") });
    const layer = Layer.mergeAll(
      databaseLayer,
      RepositoriesLive(databaseLayer),
      Layer.succeed(Ffprobe, {
        probe: () => Effect.succeed({
          durationMs: 60_000,
          streams: [
            { kind: "video", ordinal: 0, codec: "h264", bitrate: null, sampleRateHz: null, channels: null, width: 1920, height: 1080, language: null, title: null, isDefault: false },
            { kind: "subtitle", ordinal: 1, codec: "subrip", bitrate: null, sampleRateHz: null, channels: null, width: null, height: null, language: "eng", title: "English", isDefault: false },
            { kind: "subtitle", ordinal: 2, codec: "ass", bitrate: null, sampleRateHz: null, channels: null, width: null, height: null, language: "eng", title: "English (SDH)", isDefault: false },
            { kind: "audio", ordinal: 3, codec: "aac", bitrate: 128_000, sampleRateHz: 48_000, channels: 2, width: null, height: null, language: "eng", title: "English", isDefault: false },
          ],
          tags: {},
        }),
      }),
    );

    const result = await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      const libraryId = newUuid();
      const rootId = newUuid();
      const sourceId = newUuid();
      yield* database.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, 1, 1)`);
      yield* database.run(sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`);
      yield* database.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`);
      yield* database.run(sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms) VALUES (${sourceId}, ${libraryId}, ${rootId}, 'Movie.mkv', ${mediaPath}, 'local', 5, 1, '1', 1)`);
      const ingest = yield* makeMediaIngest;
      yield* ingest.ingest(sourceId);
      yield* database.run(sql`UPDATE streams SET ordinal = NULL WHERE source_id = ${sourceId}`);
      yield* ingest.ingest(sourceId);
      return yield* database.all<{ kind: string; language: string | null }>(sql`SELECT kind, language FROM streams WHERE source_id = ${sourceId} ORDER BY rowid`);
    }).pipe(Effect.provide(layer)));

    expect(result).toEqual([
      { kind: "video", language: null },
      { kind: "subtitle", language: "eng" },
      { kind: "subtitle", language: "eng" },
      { kind: "audio", language: "eng" },
    ]);
  });
});
