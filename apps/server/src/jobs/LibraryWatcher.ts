import { Database, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { stat } from "node:fs/promises";
import { LibraryService } from "../services/LibraryService";

type ScanMode = "full" | "incremental" | "refresh";

interface RootRow {
  readonly id: string;
  readonly libraryId: string;
  readonly path: string;
  readonly scanMode: ScanMode;
  readonly observedModifiedAtMs: number | null;
}

interface ChangedLibrary {
  readonly mode: ScanMode;
  readonly roots: Array<{ readonly id: string; readonly modifiedAtMs: number }>;
}

export interface LibraryWatcherShape {
  readonly check: (nowMs: number) => Effect.Effect<number, unknown>;
}

export const makeLibraryWatcher = Effect.gen(function* () {
  const database = yield* Database;
  const libraries = yield* LibraryService;

  const check: LibraryWatcherShape["check"] = Effect.fn("LibraryWatcher.check")(function* (nowMs) {
    const roots = yield* database.all<RootRow>(sql`
      SELECT r.id, r.library_id AS libraryId, r.path, p.scan_mode AS scanMode,
        watch.modified_at_ms AS observedModifiedAtMs
      FROM library_roots r
      JOIN libraries l ON l.id = r.library_id
      JOIN library_profiles p ON p.library_id = r.library_id
      LEFT JOIN server_library_watch_state watch ON watch.root_id = r.id
      WHERE l.is_enabled = 1 AND r.is_enabled = 1
      ORDER BY r.library_id, r.priority, r.path
    `);
    const changed = new Map<string, ChangedLibrary>();

    for (const root of roots) {
      const details = yield* Effect.tryPromise(() => stat(root.path)).pipe(Effect.option);
      if (details._tag === "None" || !details.value.isDirectory()) continue;

      const modifiedAtMs = Math.trunc(details.value.mtimeMs);
      if (root.observedModifiedAtMs === null) {
        yield* database.run(sql`
          INSERT INTO server_library_watch_state(root_id, modified_at_ms, checked_at_ms)
          VALUES (${root.id}, ${modifiedAtMs}, ${nowMs})
          ON CONFLICT(root_id) DO UPDATE SET modified_at_ms = excluded.modified_at_ms, checked_at_ms = excluded.checked_at_ms
        `);
        continue;
      }
      if (root.observedModifiedAtMs === modifiedAtMs) {
        yield* database.run(sql`
          UPDATE server_library_watch_state SET checked_at_ms = ${nowMs} WHERE root_id = ${root.id}
        `);
        continue;
      }

      const library = changed.get(root.libraryId) ?? { mode: root.scanMode, roots: [] };
      library.roots.push({ id: root.id, modifiedAtMs });
      changed.set(root.libraryId, library);
    }

    let scansStarted = 0;
    for (const [libraryId, library] of changed) {
      const active = yield* database.get<{ id: string }>(sql`
        SELECT id FROM scan_runs
        WHERE library_id = ${libraryId} AND status IN ('queued', 'running')
        LIMIT 1
      `);
      if (active != null) continue;

      yield* libraries.startWatchedScan({ libraryId, mode: library.mode }, library.roots, nowMs);
      scansStarted += 1;
    }

    return scansStarted;
  });

  return { check };
});

export class LibraryWatcher extends Context.Service<LibraryWatcher, LibraryWatcherShape>()(
  "@lumen/server/LibraryWatcher",
) {}

export const LibraryWatcherLive = Layer.effect(LibraryWatcher, makeLibraryWatcher);
