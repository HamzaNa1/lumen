import { Database, Repositories } from "@lumen/database";
import { sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { newUuid } from "../core/Security";
import { safePath } from "../core/Paths";

const mediaExtensions = new Set([
  ".aac", ".aif", ".aiff", ".alac", ".ape", ".flac", ".m4a", ".m4v", ".mkv", ".mp3", ".mp4", ".mpeg", ".mpg", ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma", ".wmv",
]);

const isMedia = (path: string): boolean => mediaExtensions.has(path.slice(path.lastIndexOf(".")).toLowerCase());

const existsFile = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isFile(); } catch { return false; }
};

const walk = async function* (root: string, current = root): AsyncGenerator<{ absolutePath: string; relativePath: string; size: number; modifiedAtMs: number; inode: string }> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walk(root, absolutePath);
      continue;
    }
    if (!entry.isFile() || !isMedia(entry.name)) continue;
    const details = await stat(absolutePath);
    if (!details.isFile()) continue;
    yield { absolutePath, relativePath, size: details.size, modifiedAtMs: Math.trunc(details.mtimeMs), inode: String(details.ino) };
  }
};

export const scanRoot = (rootPath: string): AsyncGenerator<{ absolutePath: string; relativePath: string; size: number; modifiedAtMs: number; inode: string }> => walk(rootPath);

export interface ScannerShape {
  readonly discover: (runId: string, rootId: string) => Effect.Effect<number, unknown>;
  readonly cleanup: (runId: string, rootId: string) => Effect.Effect<number, unknown>;
}

export const makeScanner = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;

  const discover: ScannerShape["discover"] = Effect.fn("Scanner.discover")(function* (runId, rootId) {
    const root = yield* database.get<{ path: string; libraryId: string }>(sql`
      SELECT path, library_id AS libraryId FROM library_roots WHERE id = ${rootId} AND is_enabled = 1
    `);
    if (root == null) return 0;
    const state = yield* database.get<{ generation: number }>(sql`
      SELECT generation FROM server_scan_state WHERE root_id = ${rootId}
    `);
    if (state == null) return 0;
    let count = 0;
    const files = yield* Effect.promise(() => Array.fromAsync(scanRoot(root.path))).pipe(
      Effect.tapError(() => database.run(sql`
        UPDATE library_root_states SET is_available = 0, unavailable_reason = 'UNAVAILABLE', updated_at_ms = unixepoch() * 1000
        WHERE root_id = ${rootId}
      `)),
    );
    yield* database.run(sql`
      UPDATE library_root_states SET is_available = 1, unavailable_reason = NULL, last_seen_at_ms = unixepoch() * 1000, updated_at_ms = unixepoch() * 1000
      WHERE root_id = ${rootId}
    `);
    for (const file of files) {
      const current = yield* database.get<{ generation: number }>(sql`
        SELECT generation FROM server_scan_state WHERE root_id = ${rootId}
      `);
      if (current == null || current.generation !== state.generation) return count;
      const target = yield* safePath(root.path, file.relativePath);
      let sourceId = "";
      yield* database.transaction((transaction) => Effect.gen(function* () {
        let existing = yield* transaction.get<{ id: string }>(sql`
          SELECT id FROM media_sources WHERE absolute_path = ${target}
        `);
        if (existing == null) {
          const candidates = yield* transaction.all<{ id: string; absolutePath: string }>(sql`
            SELECT id, absolute_path AS absolutePath FROM media_sources
            WHERE library_id = ${root.libraryId} AND inode = ${file.inode} AND file_size_bytes = ${file.size}
              AND NOT EXISTS (SELECT 1 FROM server_scan_seen ss WHERE ss.run_id = ${runId} AND ss.source_id = media_sources.id)
          `);
          for (const candidate of candidates) {
            if (!(yield* Effect.promise(() => existsFile(candidate.absolutePath)))) {
              existing = candidate;
              break;
            }
          }
        }
        sourceId = existing?.id ?? newUuid();
        if (existing == null) {
          yield* transaction.run(sql`
            INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, content_fingerprint, scanned_at_ms)
            VALUES (${sourceId}, ${root.libraryId}, ${rootId}, ${file.relativePath}, ${target}, 'local', ${file.size}, ${file.modifiedAtMs}, ${file.inode}, NULL, unixepoch() * 1000)
          `);
        } else {
          yield* transaction.run(sql`
            UPDATE media_sources SET root_id = ${rootId}, relative_path = ${file.relativePath}, absolute_path = ${target},
              file_size_bytes = ${file.size}, modified_at_ms = ${file.modifiedAtMs}, inode = ${file.inode}, scanned_at_ms = unixepoch() * 1000
            WHERE id = ${sourceId}
          `);
        }
        yield* transaction.run(sql`
          INSERT INTO media_source_availability(source_id, is_available, last_seen_at_ms, missing_since_ms, updated_at_ms)
          VALUES (${sourceId}, 1, unixepoch() * 1000, NULL, unixepoch() * 1000)
          ON CONFLICT(source_id) DO UPDATE SET is_available = 1, last_seen_at_ms = excluded.last_seen_at_ms, missing_since_ms = NULL, updated_at_ms = excluded.updated_at_ms
        `);
        yield* transaction.run(sql`
          INSERT OR REPLACE INTO server_scan_seen(run_id, source_id, seen_at_ms) VALUES (${runId}, ${sourceId}, unixepoch() * 1000)
        `);
      }));
      yield* repositories.scanning.createJob({
        id: newUuid(),
        runId,
        parentJobId: null,
        sourceId,
        dedupeKey: `probe:${sourceId}`,
        operation: "probe",
        priority: 500,
        maxAttempts: 5,
        availableAtMs: Date.now(),
      }).pipe(Effect.catch(() => Effect.void));
      count += 1;
    }
    return count;
  });

  const cleanup: ScannerShape["cleanup"] = Effect.fn("Scanner.cleanup")(function* (runId, rootId) {
    const removed = yield* database.all<{ id: string }>(sql`
      SELECT s.id
      FROM media_sources s
      WHERE s.root_id = ${rootId}
        AND NOT EXISTS (SELECT 1 FROM server_scan_seen ss WHERE ss.run_id = ${runId} AND ss.source_id = s.id)
    `);
    for (const source of removed) {
      yield* database.run(sql`
        INSERT INTO media_source_availability(source_id, is_available, last_seen_at_ms, missing_since_ms, updated_at_ms)
        VALUES (${source.id}, 0, NULL, unixepoch() * 1000, unixepoch() * 1000)
        ON CONFLICT(source_id) DO UPDATE SET is_available = 0, missing_since_ms = excluded.missing_since_ms, updated_at_ms = excluded.updated_at_ms
      `);
    }
    return removed.length;
  });

  return { discover, cleanup };
});

export class Scanner extends Context.Service<Scanner, ScannerShape>()(
  "@lumen/server/Scanner",
) {}

export const ScannerLive = Layer.effect(Scanner, makeScanner);
