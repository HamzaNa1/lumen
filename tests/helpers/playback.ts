import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
export const seedPlaybackFixture = async (
  root: string,
  databasePath: string,
): Promise<{
  readonly userId: string;
  readonly libraryId: string;
  readonly trackId: string;
  readonly itemId: string;
  readonly audioStreamId: string;
  readonly subtitleStreamId: string;
}> => {
  const mediaPath = join(root, "clip.mkv");
  await Bun.write(mediaPath, "0123456789");
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const userId = newUuid();
      const libraryId = newUuid();
      const trackId = newUuid();
      const itemId = newUuid();
      yield* database.run(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${userId}, 'admin', 'admin', 'Admin', ${yield* Effect.promise(() => hashPassword("correct horse battery staple"))}, 'admin', 1, unixepoch() * 1000, unixepoch() * 1000)
    `);
      yield* database.run(
        sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, unixepoch() * 1000, unixepoch() * 1000)`,
      );
      yield* database.run(
        sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`,
      );
      const sourceId = newUuid();
      const streamId = newUuid();
      const audioStreamId = newUuid();
      const subtitleStreamId = newUuid();
      const rootId = newUuid();
      yield* database.run(sql`
      INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms)
      VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, unixepoch() * 1000, unixepoch() * 1000)
    `);
      yield* database.run(sql`
      INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
      VALUES (${sourceId}, ${libraryId}, ${rootId}, 'clip.mkv', ${mediaPath}, 'local', 10, unixepoch() * 1000, '1', unixepoch() * 1000)
    `);
      const source = yield* database.get<{ id: string }>(
        sql`SELECT id FROM media_sources WHERE absolute_path = ${mediaPath}`,
      );
      if (source !== null) {
        yield* database.run(
          sql`INSERT INTO streams(id, source_id, kind, container, codec, ordinal, is_default) VALUES (${streamId}, ${source.id}, 'video', 'matroska', 'h264', 0, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default) VALUES (${audioStreamId}, ${source.id}, 'audio', 'matroska', 'aac', 'eng', 'English', 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default) VALUES (${subtitleStreamId}, ${source.id}, 'subtitle', 'matroska', 'subrip', 'eng', 'English', 2, 1)`,
        );
        yield* database.run(sql`
        INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, duration_ms, is_explicit, created_at_ms, updated_at_ms)
        VALUES (${trackId}, ${libraryId}, ${source.id}, ${streamId}, 'Clip', 'clip', 10000, 0, unixepoch() * 1000, unixepoch() * 1000)
      `);
        yield* database.run(sql`
        INSERT INTO catalog_items(id, library_id, kind, title, sort_title, duration_seconds, metadata_state, added_at_ms, updated_at_ms)
        VALUES (${itemId}, ${libraryId}, 'movie', 'Clip', 'clip', 10, 'local', unixepoch() * 1000, unixepoch() * 1000)
      `);
        yield* database.run(
          sql`INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (${itemId}, ${source.id}, 1, 1)`,
        );
      }
      return { userId, libraryId, trackId, itemId, audioStreamId, subtitleStreamId };
    }).pipe(Effect.provide(layer)),
  );
};
