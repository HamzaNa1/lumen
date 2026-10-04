import {
  Database,
  libraries as libraryTable,
  libraryRoots,
  serverLibraryWatchState,
} from "@lumen/database";
import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { stat } from "node:fs/promises";
import { ServerError } from "../core/Errors";
import { LibraryService } from "../services/LibraryService";

interface RootRow {
  readonly id: string;
  readonly libraryId: string;
  readonly path: string;
  readonly observedModifiedAtMs: number | null;
}

type RootObservations = Array<{ readonly id: string; readonly modifiedAtMs: number }>;

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
        observedModifiedAtMs: serverLibraryWatchState.modifiedAtMs,
      })
      .from(libraryRoots)
      .innerJoin(libraryTable, eq(libraryTable.id, libraryRoots.libraryId))
      .leftJoin(serverLibraryWatchState, eq(serverLibraryWatchState.rootId, libraryRoots.id))
      .where(and(eq(libraryTable.isEnabled, true), eq(libraryRoots.isEnabled, true)))
      .orderBy(
        asc(libraryRoots.libraryId),
        asc(libraryRoots.priority),
        asc(libraryRoots.path),
      )) as ReadonlyArray<RootRow>;
    const pending = new Map<string, RootObservations>();

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
      // A root's mtime cannot reveal nested changes or file overwrites. Reconcile
      // on every scheduled check; incremental discovery skips unchanged probes.
      const observations = pending.get(root.libraryId) ?? [];
      observations.push({ id: root.id, modifiedAtMs });
      pending.set(root.libraryId, observations);
    }

    let scansStarted = 0;
    for (const [libraryId, observations] of pending) {
      // A conflict means the library cannot be scanned right now: a scan is already
      // active, or it was disabled or lost its roots since the roots were loaded.
      // A later scheduled check retries reconciliation.
      // Watcher scans reconcile changes only; unchanged media is not re-probed.
      const started = yield* libraries
        .startWatchedScan({ libraryId, mode: "incremental" }, observations, nowMs)
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error instanceof ServerError && error.code === "conflict",
            () => Effect.succeed(false),
          ),
        );
      if (started) scansStarted += 1;
    }

    return scansStarted;
  });

  return { check };
});

export class LibraryWatcher extends Context.Service<LibraryWatcher, LibraryWatcherShape>()(
  "@lumen/server/LibraryWatcher",
) {}

export const LibraryWatcherLive = Layer.effect(LibraryWatcher, makeLibraryWatcher);
