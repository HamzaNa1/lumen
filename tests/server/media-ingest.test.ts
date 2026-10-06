import { afterEach, describe, expect, test } from "bun:test";
import { Database, DatabaseWithMigrationsLive, RepositoriesLive, defaultMigrationsFolder, streams, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { makeMediaIngest } from "../../apps/server/src/media/MediaIngest";
import { defaultTrackMemory, describeTrack, resolveTrackSelection, type PlayableStream } from "../../packages/contracts/src/index.ts";

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("media ingest", () => {
  test.each(["missing ordinals", "upgraded role metadata"])("persists multiple streams after refreshing %s", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "lumen-ingest-test-"));
    paths.push(root);
    const mediaPath = join(root, "Movie.mkv");
    await writeFile(mediaPath, "media");
    const filename = join(root, "ingest.sqlite");
    const earlier = join(root, "earlier");
    if (scenario === "upgraded role metadata")
      await cp(defaultMigrationsFolder, earlier, { recursive: true, filter: (path) => !path.includes("20261006061748_true_songbird") });
    const databaseLayer = DatabaseWithMigrationsLive({ filename });
    const layer = Layer.mergeAll(
      databaseLayer,
      RepositoriesLive(databaseLayer),
      Layer.succeed(Ffprobe, {
        probe: () => Effect.succeed({
          durationMs: 60_000,
          streams: [
            { kind: "video", ordinal: 0, codec: "h264", bitrate: null, sampleRateHz: null, channels: null, width: 1920, height: 1080, language: null, title: null, isDefault: false },
            { kind: "subtitle", ordinal: 1, codec: "subrip", bitrate: null, sampleRateHz: null, channels: null, width: null, height: null, language: "eng", title: "English", isDefault: false, commentary: false, forced: true, hearingImpaired: false },
            { kind: "subtitle", ordinal: 2, codec: "ass", bitrate: null, sampleRateHz: null, channels: null, width: null, height: null, language: "eng", title: "English (SDH)", isDefault: false, commentary: false, forced: false, hearingImpaired: true },
            { kind: "audio", ordinal: 3, codec: "aac", bitrate: 128_000, sampleRateHz: 48_000, channels: 2, width: null, height: null, language: "eng", title: "English", isDefault: false, commentary: true, forced: false, hearingImpaired: false },
          ],
          tags: {},
        }),
      }),
    );

    const sourceId = newUuid();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database;
      const libraryId = newUuid();
      const rootId = newUuid();
      yield* database.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, 1, 1)`);
      yield* database.run(sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`);
      yield* database.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`);
      yield* database.run(sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms) VALUES (${sourceId}, ${libraryId}, ${rootId}, 'Movie.mkv', ${mediaPath}, 'local', 5, 1, '1', 1)`);
      if (scenario === "upgraded role metadata") {
        yield* database.run(sql`INSERT INTO streams(id, source_id, kind, codec, language, title, ordinal, is_default) VALUES
          ('video', ${sourceId}, 'video', 'h264', NULL, NULL, 0, 1),
          ('forced', ${sourceId}, 'subtitle', 'subrip', 'eng', 'English', 1, 0),
          ('sdh', ${sourceId}, 'subtitle', 'ass', 'eng', 'English (SDH)', 2, 0),
          ('commentary', ${sourceId}, 'audio', 'aac', 'eng', 'English', 3, 1)`);
        yield* database.run(sql`INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, created_at_ms, updated_at_ms)
          VALUES ('track', ${libraryId}, ${sourceId}, 'video', 'Movie', 'movie', 1, 1)`);
      }
    }).pipe(Effect.provide(DatabaseWithMigrationsLive({ filename }, scenario === "upgraded role metadata" ? earlier : undefined)))));

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database;
      const ingest = yield* makeMediaIngest;
      if (scenario === "missing ordinals") {
        yield* ingest.ingest(sourceId);
        yield* database.run(sql`UPDATE streams SET ordinal = NULL WHERE source_id = ${sourceId}`);
      } else {
        const before = yield* database.get<{ ordinal: number; commentary: number | null }>(sql`SELECT ordinal, commentary FROM streams WHERE id = 'commentary'`);
        expect(before).toEqual({ ordinal: 3, commentary: null });
      }
      yield* ingest.ingest(sourceId);
      if (scenario === "upgraded role metadata") {
        // Repeating the rescan must preserve exact-file identities as well as the recovered roles.
        yield* ingest.ingest(sourceId);
        const recovered = yield* database.select().from(streams);
        expect(recovered.map((stream) => stream.id)).toEqual(["video", "forced", "sdh", "commentary"]);
        const playable: PlayableStream[] = recovered.map((stream) => ({ ...stream, ordinal: stream.ordinal ?? 0 }));
        const sdh = playable.find((stream) => stream.id === "sdh");
        if (sdh === undefined) throw new Error("Missing subtitle fixture");
        const nextEpisode = playable.map((stream) => ({ ...stream, id: `next-${stream.id}` }));
        expect(resolveTrackSelection(nextEpisode, "next-episode", {
          ...defaultTrackMemory(), subtitle: describeTrack(sourceId, sdh),
        }).subtitle?.id).toBe("next-sdh");
      }
      return yield* database.all<{ kind: string; language: string | null }>(sql`SELECT kind, language, channels, commentary, forced, hearing_impaired FROM streams WHERE source_id = ${sourceId} ORDER BY rowid`);
    }).pipe(Effect.provide(layer))));

    expect(result).toEqual([
      { kind: "video", language: null, channels: null, commentary: null, forced: null, hearing_impaired: null },
      { kind: "subtitle", language: "eng", channels: null, commentary: 0, forced: 1, hearing_impaired: 0 },
      { kind: "subtitle", language: "eng", channels: null, commentary: 0, forced: 0, hearing_impaired: 1 },
      { kind: "audio", language: "eng", channels: 2, commentary: 1, forced: 0, hearing_impaired: 0 },
    ]);
  });
});
