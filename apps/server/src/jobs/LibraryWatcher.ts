import {
  Database,
  libraries as libraryTable,
  libraryProfiles,
  libraryRoots,
  scanRuns,
  serverLibraryWatchState,
} from "@lumen/database";
import { and, asc, eq, inArray } from "drizzle-orm";
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
    const roots = (yield* database
      .select({
        id: libraryRoots.id,
        libraryId: libraryRoots.libraryId,
        path: libraryRoots.path,
        scanMode: libraryProfiles.scanMode,
        observedModifiedAtMs: serverLibraryWatchState.modifiedAtMs,
      })
      .from(libraryRoots)
      .innerJoin(libraryTable, eq(libraryTable.id, libraryRoots.libraryId))
      .innerJoin(libraryProfiles, eq(libraryProfiles.libraryId, libraryRoots.libraryId))
      .leftJoin(serverLibraryWatchState, eq(serverLibraryWatchState.rootId, libraryRoots.id))
      .where(and(eq(libraryTable.isEnabled, true), eq(libraryRoots.isEnabled, true)))
      .orderBy(
        asc(libraryRoots.libraryId),
        asc(libraryRoots.priority),
        asc(libraryRoots.path),
      )) as ReadonlyArray<RootRow>;
    const changed = new Map<string, ChangedLibrary>();

    for (const root of roots) {
      const details = yield* Effect.tryPromise(() => stat(root.path)).pipe(Effect.option);
      if (details._tag === "None" || !details.value.isDirectory()) continue;

      const modifiedAtMs = Math.trunc(details.value.mtimeMs);
      if (root.observedModifiedAtMs === null) {
        yield* database
          .insert(serverLibraryWatchState)
          .values({
            rootId: root.id,
            modifiedAtMs,
            checkedAtMs: nowMs,
          })
          .onConflictDoUpdate({
            target: serverLibraryWatchState.rootId,
            set: { modifiedAtMs, checkedAtMs: nowMs },
          });
        continue;
      }
      if (root.observedModifiedAtMs === modifiedAtMs) {
        yield* database
          .update(serverLibraryWatchState)
          .set({ checkedAtMs: nowMs })
          .where(eq(serverLibraryWatchState.rootId, root.id));
        continue;
      }

      const library = changed.get(root.libraryId) ?? { mode: root.scanMode, roots: [] };
      library.roots.push({ id: root.id, modifiedAtMs });
      changed.set(root.libraryId, library);
    }

    let scansStarted = 0;
    for (const [libraryId, library] of changed) {
      const active = yield* database
        .select({ id: scanRuns.id })
        .from(scanRuns)
        .where(
          and(eq(scanRuns.libraryId, libraryId), inArray(scanRuns.status, ["queued", "running"])),
        )
        .get();
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
