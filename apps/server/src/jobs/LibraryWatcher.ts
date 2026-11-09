import { Database, libraries, scanRuns } from "@lumen/database";
import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Scanner } from "../services/Scanner";

export interface LibraryWatcherShape {
  readonly check: (nowMs: number) => Effect.Effect<number, unknown>;
}

export const makeLibraryWatcher = Effect.gen(function* () {
  const database = yield* Database;
  const scanner = yield* Scanner;
  const check: LibraryWatcherShape["check"] = Effect.fn("LibraryWatcher.check")(function* (nowMs) {
    const idle = yield* database
      .select({ id: libraries.id })
      .from(libraries)
      .where(
        and(
          eq(libraries.isEnabled, true),
          notExists(
            database
              .select({ id: scanRuns.id })
              .from(scanRuns)
              .where(
                and(
                  eq(scanRuns.libraryId, libraries.id),
                  inArray(scanRuns.status, ["queued", "running"]),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(libraries.id));
    let started = 0;
    for (const library of idle) if (yield* scanner.reconcile(library.id, nowMs)) started++;
    return started;
  });
  return { check };
});

export class LibraryWatcher extends Context.Service<LibraryWatcher, LibraryWatcherShape>()(
  "@lumen/server/LibraryWatcher",
) {}
export const LibraryWatcherLive = Layer.effect(LibraryWatcher, makeLibraryWatcher);
