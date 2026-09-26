import type { Library, LibraryGrant, LibraryRoot } from "@lumen/contracts";
import {
  catalogItems,
  Database,
  libraries,
  libraryProfiles,
  libraryRoots,
  libraryRootStates,
  mediaSources,
  Repositories,
  scanJobs,
  scanRuns,
  serverLibraryWatchState,
} from "@lumen/database";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { lstat } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, notFound } from "../core/Errors";
import { assertNoRootOverlap, canonicalPath } from "../core/Paths";
import { newUuid } from "../core/Security";
import { purgeLibrary, purgeSources } from "./CatalogPurge";
import type { CreateLibraryBody, CreateRootBody, UpdateLibraryBody } from "../http/Schemas";
import type { Schema } from "effect";
import type { CreateGrantBody, StartScanBody } from "../http/Schemas";

type LibraryInput = Schema.Schema.Type<typeof CreateLibraryBody>;
type UpdateLibraryInput = Schema.Schema.Type<typeof UpdateLibraryBody>;
type RootInput = Schema.Schema.Type<typeof CreateRootBody>;
type GrantInput = Schema.Schema.Type<typeof CreateGrantBody>;
type ScanInput = Schema.Schema.Type<typeof StartScanBody>;
type RootObservation = { readonly id: string; readonly modifiedAtMs: number };

export interface LibraryServiceShape {
  readonly create: (input: LibraryInput, nowMs: number) => Effect.Effect<Library, unknown>;
  readonly update: (
    libraryId: string,
    input: UpdateLibraryInput,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
  readonly remove: (libraryId: string) => Effect.Effect<void, unknown>;
  readonly addRoot: (input: RootInput, nowMs: number) => Effect.Effect<LibraryRoot, unknown>;
  readonly listRoots: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryRoot>, unknown>;
  readonly listGrants: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryGrant>, unknown>;
  readonly deleteRoot: (rootId: string) => Effect.Effect<void, unknown>;
  readonly upsertGrant: (input: GrantInput, nowMs: number) => Effect.Effect<LibraryGrant, unknown>;
  readonly startScan: (
    input: ScanInput,
    nowMs: number,
  ) => Effect.Effect<{ runId: string }, unknown>;
  readonly startWatchedScan: (
    input: ScanInput,
    roots: ReadonlyArray<RootObservation>,
    nowMs: number,
  ) => Effect.Effect<{ runId: string }, unknown>;
}

export const makeLibraryService = Effect.gen(function* () {
  const repositories = yield* Repositories;
  const database = yield* Database;

  const librarySelection = {
    id: libraries.id,
    name: libraries.name,
    slug: libraries.slug,
    isEnabled: libraries.isEnabled,
    createdAtMs: libraries.createdAtMs,
    updatedAtMs: libraries.updatedAtMs,
  };
  const rootSelection = {
    id: libraryRoots.id,
    libraryId: libraryRoots.libraryId,
    path: libraryRoots.path,
    isEnabled: libraryRoots.isEnabled,
    priority: libraryRoots.priority,
    createdAtMs: libraryRoots.createdAtMs,
    updatedAtMs: libraryRoots.updatedAtMs,
  };
  const create: LibraryServiceShape["create"] = Effect.fn("LibraryService.create")(
    function* (input, nowMs) {
      const row = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const [created] = yield* transaction
            .insert(libraries)
            .values({
              id: input.id,
              name: input.name,
              slug: input.slug,
              isEnabled: true,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .returning(librarySelection);
          yield* transaction.insert(libraryProfiles).values({
            libraryId: input.id,
            kind: input.kind ?? "movies",
            scanMode: input.kind === "music" ? "incremental" : "full",
          });
          return created;
        }),
      );
      return { ...row, kind: input.kind ?? "movies" } as Library;
    },
  );

  const update: LibraryServiceShape["update"] = Effect.fn("LibraryService.update")(
    function* (libraryId, input, nowMs) {
      return yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const [row] = yield* transaction
            .update(libraries)
            .set({
              name: input.name?.trim(),
              slug: input.slug,
              isEnabled: input.isEnabled,
              updatedAtMs: nowMs,
            })
            .where(eq(libraries.id, libraryId))
            .returning(librarySelection);
          if (row == null) return yield* notFound("Library not found");
          const profile = yield* transaction
            .select({ kind: libraryProfiles.kind })
            .from(libraryProfiles)
            .where(eq(libraryProfiles.libraryId, libraryId))
            .get();
          const currentKind = (profile?.kind ?? "movies") as "movies" | "shows" | "music";
          if (input.kind !== undefined && input.kind !== currentKind) {
            const catalog = yield* transaction
              .select({ count: count() })
              .from(catalogItems)
              .where(eq(catalogItems.libraryId, libraryId))
              .get();
            if ((catalog?.count ?? 0) > 0)
              return yield* conflict("Library type cannot change after media has been indexed");
            yield* transaction
              .insert(libraryProfiles)
              .values({
                libraryId,
                kind: input.kind,
                scanMode: input.kind === "music" ? "incremental" : "full",
              })
              .onConflictDoUpdate({
                target: libraryProfiles.libraryId,
                set: { kind: input.kind },
              });
          }
          return { ...row, kind: input.kind ?? currentKind };
        }),
      );
    },
  );

  const remove: LibraryServiceShape["remove"] = Effect.fn("LibraryService.remove")(
    function* (libraryId) {
      const counts = yield* database
        .transaction((transaction) => purgeLibrary(transaction, libraryId))
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => console.error("library_deleted", { libraryId, result: "failed" })),
          ),
        );
      console.info("library_deleted", {
        libraryId,
        result: counts === null ? "not_found" : "succeeded",
        ...counts,
      });
    },
  );

  const addRoot: LibraryServiceShape["addRoot"] = Effect.fn("LibraryService.addRoot")(
    function* (input, nowMs) {
      const library = yield* database
        .select({ isEnabled: libraries.isEnabled })
        .from(libraries)
        .where(eq(libraries.id, input.libraryId))
        .get();
      if (library == null) return yield* conflict("Library does not exist");
      if (!library.isEnabled) return yield* conflict("Library is disabled");
      const rootPath = yield* Effect.tryPromise({
        try: () => canonicalPath(input.path),
        catch: (cause) => conflict(cause instanceof Error ? cause.message : "Root does not exist"),
      });
      const stat = yield* Effect.tryPromise({
        try: () => lstat(rootPath),
        catch: () => conflict("Root is not accessible"),
      });
      if (!stat.isDirectory()) return yield* conflict("Root must be a directory");
      const roots = yield* database.select({ path: libraryRoots.path }).from(libraryRoots);
      yield* assertNoRootOverlap(
        roots.map((root) => root.path),
        rootPath,
      );
      const canonicalKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
      const row = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const [created] = yield* transaction
            .insert(libraryRoots)
            .values({
              id: input.id,
              libraryId: input.libraryId,
              path: rootPath,
              isEnabled: true,
              priority: input.priority,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .returning(rootSelection);
          yield* transaction.insert(libraryRootStates).values({
            rootId: input.id,
            libraryId: input.libraryId,
            canonicalPath: rootPath,
            canonicalKey,
            isAvailable: true,
            scanGeneration: 0,
            updatedAtMs: nowMs,
          });
          return created;
        }),
      );
      return row;
    },
  );

  const listRoots: LibraryServiceShape["listRoots"] = Effect.fn("LibraryService.listRoots")(
    function* (libraryId) {
      const roots = yield* database
        .select({
          ...rootSelection,
          isAvailable: libraryRootStates.isAvailable,
          unavailableReason: libraryRootStates.unavailableReason,
        })
        .from(libraryRoots)
        .leftJoin(libraryRootStates, eq(libraryRootStates.rootId, libraryRoots.id))
        .where(eq(libraryRoots.libraryId, libraryId))
        .orderBy(asc(libraryRoots.priority), asc(libraryRoots.path));
      return roots.map((root) => ({ ...root, isAvailable: root.isAvailable ?? true }));
    },
  );

  const listGrants: LibraryServiceShape["listGrants"] = Effect.fn("LibraryService.listGrants")(
    function* (libraryId) {
      return yield* repositories.libraries
        .listGrants({ libraryId })
        .pipe(Effect.mapError(mapRepositoryError));
    },
  );

  const deleteRoot: LibraryServiceShape["deleteRoot"] = Effect.fn("LibraryService.deleteRoot")(
    function* (rootId) {
      const counts = yield* database
        .transaction((transaction) =>
          Effect.gen(function* () {
            const sources = yield* transaction
              .select({ id: mediaSources.id })
              .from(mediaSources)
              .where(eq(mediaSources.rootId, rootId));
            const counts = yield* purgeSources(
              transaction,
              sources.map((source) => source.id),
            );
            yield* transaction.delete(libraryRoots).where(eq(libraryRoots.id, rootId));
            return counts;
          }),
        )
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => console.error("library_root_deleted", { rootId, result: "failed" })),
          ),
        );
      console.info("library_root_deleted", { rootId, result: "succeeded", ...counts });
    },
  );

  const upsertGrant: LibraryServiceShape["upsertGrant"] = Effect.fn("LibraryService.upsertGrant")(
    function* (input, nowMs) {
      return yield* repositories.libraries
        .upsertGrant({ ...input, nowMs })
        .pipe(Effect.mapError(mapRepositoryError));
    },
  );

  const enqueueScan = Effect.fn("LibraryService.enqueueScan")(function* (
    input: ScanInput,
    nowMs: number,
    observations: ReadonlyArray<RootObservation>,
  ) {
    const library = yield* database
      .select({ isEnabled: libraries.isEnabled })
      .from(libraries)
      .where(eq(libraries.id, input.libraryId))
      .get();
    if (library == null || !library.isEnabled) return yield* conflict("Library is disabled");
    const enabledRoots = yield* database
      .select(rootSelection)
      .from(libraryRoots)
      .where(and(eq(libraryRoots.libraryId, input.libraryId), eq(libraryRoots.isEnabled, true)))
      .orderBy(asc(libraryRoots.priority), asc(libraryRoots.path));
    if (enabledRoots.length === 0) return yield* conflict("Library has no enabled roots");
    const runId = newUuid();
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const active = yield* transaction
          .select({ id: scanRuns.id })
          .from(scanRuns)
          .where(
            and(
              eq(scanRuns.libraryId, input.libraryId),
              inArray(scanRuns.status, ["queued", "running"]),
            ),
          )
          .get();
        if (active != null) return yield* conflict("Library scan is already running");

        for (const root of enabledRoots) {
          yield* transaction
            .update(libraryRootStates)
            .set({
              scanGeneration: sql`${libraryRootStates.scanGeneration} + 1`,
              updatedAtMs: nowMs,
            })
            .where(eq(libraryRootStates.rootId, root.id));
        }
        yield* transaction.insert(scanRuns).values({
          id: runId,
          libraryId: input.libraryId,
          mode: input.mode,
          status: "running",
          startedAtMs: nowMs,
          createdAtMs: nowMs,
        });
        for (const root of enabledRoots) {
          yield* transaction.insert(scanJobs).values({
            id: newUuid(),
            runId,
            parentJobId: null,
            sourceId: null,
            dedupeKey: `discover:${root.id}`,
            operation: "discover",
            status: "queued",
            priority: 100,
            attempts: 0,
            maxAttempts: 3,
            availableAtMs: nowMs,
          });
        }
        for (const observation of observations) {
          yield* transaction
            .update(serverLibraryWatchState)
            .set({
              modifiedAtMs: observation.modifiedAtMs,
              checkedAtMs: nowMs,
            })
            .where(eq(serverLibraryWatchState.rootId, observation.id));
        }
      }),
    );
    return { runId };
  });

  const startScan: LibraryServiceShape["startScan"] = (input, nowMs) =>
    enqueueScan(input, nowMs, []);
  const startWatchedScan: LibraryServiceShape["startWatchedScan"] = (input, roots, nowMs) =>
    enqueueScan(input, nowMs, roots);

  return {
    create,
    update,
    remove,
    addRoot,
    listRoots,
    listGrants,
    deleteRoot,
    upsertGrant,
    startScan,
    startWatchedScan,
  };
});

export class LibraryService extends Context.Service<LibraryService, LibraryServiceShape>()(
  "@lumen/server/Library",
) {}

export const LibraryServiceLive = Layer.effect(LibraryService, makeLibraryService);
