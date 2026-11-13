import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DirectoryListing, Library, LibraryGrant, LibraryRoot } from "@lumen/contracts";
import {
  catalogItems,
  Database,
  type DatabaseTransaction,
  libraries,
  libraryProfiles,
  libraryRootStates,
  libraryRoots,
  mediaSources,
  Repositories,
  scanRuns,
} from "@lumen/database";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Schema } from "effect";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { badRequest, conflict, internal, notFound, ServerError } from "../core/Errors";
import { ServerLogger } from "../core/Logger";
import { assertNoRootOverlap, canonicalPath } from "../core/Paths";
import { newUuid } from "../core/Security";
import type {
  CreateGrantBody,
  CreateLibraryBody,
  CreateRootBody,
  StartScanBody,
  UpdateLibraryBody,
} from "../http/Schemas";
import { insertScanRun } from "../jobs/ScanJobs";
import { purgeLibrary, purgeSources } from "./CatalogPurge";
import { listDirectory } from "./DirectoryListing";

type LibraryInput = Schema.Schema.Type<typeof CreateLibraryBody>;
type UpdateLibraryInput = Schema.Schema.Type<typeof UpdateLibraryBody>;
type RootInput = Schema.Schema.Type<typeof CreateRootBody>;
type GrantInput = Schema.Schema.Type<typeof CreateGrantBody>;
type ScanInput = Schema.Schema.Type<typeof StartScanBody>;

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
  /** Lists a folder on the server, or the server account's home folder when path is null. */
  readonly listDirectory: (path: string | null) => Effect.Effect<DirectoryListing, unknown>;
  readonly upsertGrant: (input: GrantInput, nowMs: number) => Effect.Effect<LibraryGrant, unknown>;
  readonly startScan: (
    input: ScanInput,
    nowMs: number,
  ) => Effect.Effect<{ runId: string }, unknown>;
}

export const makeLibraryService = Effect.gen(function* () {
  const logger = (yield* ServerLogger).child({ component: "libraries" });
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
  const purgeRoot = Effect.fn("LibraryService.purgeRoot")(function* (
    transaction: DatabaseTransaction,
    rootId: string,
  ) {
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
  });

  const resolveRootPath = Effect.fn("LibraryService.resolveRootPath")(function* (path: string) {
    const rootPath = yield* Effect.tryPromise({
      try: () => canonicalPath(path),
      catch: (cause) => conflict(cause instanceof Error ? cause.message : "Root does not exist"),
    });
    const stat = yield* Effect.tryPromise({
      try: () => lstat(rootPath),
      catch: () => conflict("Root is not accessible"),
    });
    if (!stat.isDirectory()) return yield* conflict("Root must be a directory");
    return rootPath;
  });

  // Overlap is checked inside the transaction so two roots added at once cannot both pass.
  const insertRoot = Effect.fn("LibraryService.insertRoot")(function* (
    transaction: DatabaseTransaction,
    root: {
      readonly id: string;
      readonly libraryId: string;
      readonly priority: number;
      readonly replacesRootId?: string | undefined;
    },
    rootPath: string,
    nowMs: number,
  ) {
    const roots = yield* transaction
      .select({ id: libraryRoots.id, path: libraryRoots.path })
      .from(libraryRoots);
    yield* assertNoRootOverlap(
      roots
        .filter((existing) => existing.id !== root.replacesRootId)
        .map((existing) => existing.path),
      rootPath,
    );
    const [created] = yield* transaction
      .insert(libraryRoots)
      .values({
        id: root.id,
        libraryId: root.libraryId,
        path: rootPath,
        isEnabled: true,
        priority: root.priority,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .returning(rootSelection);
    yield* transaction.insert(libraryRootStates).values({
      rootId: root.id,
      libraryId: root.libraryId,
      canonicalPath: rootPath,
      canonicalKey: process.platform === "win32" ? rootPath.toLowerCase() : rootPath,
      isAvailable: true,
      updatedAtMs: nowMs,
    });
    if (created === undefined) return yield* Effect.die(new Error("Root insert returned no row"));
    return created;
  });

  const create: LibraryServiceShape["create"] = Effect.fn("LibraryService.create")(
    function* (input, nowMs) {
      const root = input.root;
      const rootPath = root === undefined ? null : yield* resolveRootPath(root.path);
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
          if (created === undefined)
            return yield* Effect.die(new Error("Library insert returned no row"));
          if (root !== undefined && rootPath !== null)
            yield* insertRoot(
              transaction,
              { id: root.id, libraryId: input.id, priority: 0 },
              rootPath,
              nowMs,
            );
          return created;
        }),
      );
      return { ...row, kind: input.kind ?? "movies" };
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
          Effect.tapError((cause) =>
            Effect.sync(() =>
              logger.error("library_deleted", { libraryId, result: "failed" }, cause),
            ),
          ),
        );
      logger.info("library_deleted", {
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
      const rootPath = yield* resolveRootPath(input.path);
      const replaced = input.replacesRootId;
      const { row, counts } = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          if (replaced === undefined)
            return { row: yield* insertRoot(transaction, input, rootPath, nowMs), counts: null };
          const existing = yield* transaction
            .select({ libraryId: libraryRoots.libraryId })
            .from(libraryRoots)
            .where(eq(libraryRoots.id, replaced))
            .get();
          if (existing?.libraryId !== input.libraryId)
            return yield* notFound("Root not found in this library");
          const counts = yield* purgeRoot(transaction, replaced);
          return { row: yield* insertRoot(transaction, input, rootPath, nowMs), counts };
        }),
      );
      if (replaced !== undefined)
        logger.info("library_root_replaced", {
          rootId: replaced,
          replacementId: row.id,
          result: "succeeded",
          ...counts,
        });
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
        .transaction((transaction) => purgeRoot(transaction, rootId))
        .pipe(
          Effect.tapError((cause) =>
            Effect.sync(() =>
              logger.error("library_root_deleted", { rootId, result: "failed" }, cause),
            ),
          ),
        );
      logger.info("library_root_deleted", { rootId, result: "succeeded", ...counts });
    },
  );

  const listFolder: LibraryServiceShape["listDirectory"] = Effect.fn(
    "LibraryService.listDirectory",
  )(function* (path) {
    if (path !== null && !isAbsolute(path))
      return yield* badRequest("Folder path must be absolute");
    const roots = yield* database
      .select({
        rootId: libraryRoots.id,
        libraryId: libraryRoots.libraryId,
        libraryName: libraries.name,
        path: libraryRoots.path,
      })
      .from(libraryRoots)
      .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId));
    return yield* Effect.tryPromise({
      try: () => listDirectory(path, roots),
      catch: (cause) =>
        cause instanceof ServerError ? cause : internal("Could not read folder", cause),
    });
  });

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

        yield* insertScanRun(
          transaction,
          {
            runId,
            libraryId: input.libraryId,
            mode: input.mode,
            jobs: [
              {
                sourceId: null,
                dedupeKey: `discover:${input.libraryId}`,
                operation: "discover",
                priority: 100,
                maxAttempts: 3,
              },
            ],
          },
          nowMs,
        );
      }),
    );
    logger.info("scan_run_queued", {
      runId,
      libraryId: input.libraryId,
      mode: input.mode,
      roots: enabledRoots.length,
    });
    return { runId };
  });

  const startScan: LibraryServiceShape["startScan"] = (input, nowMs) => enqueueScan(input, nowMs);

  return {
    create,
    update,
    remove,
    addRoot,
    listRoots,
    listGrants,
    deleteRoot,
    listDirectory: listFolder,
    upsertGrant,
    startScan,
  };
});

export class LibraryService extends Context.Service<LibraryService, LibraryServiceShape>()(
  "@lumen/server/Library",
) {}

export const LibraryServiceLive = Layer.effect(LibraryService, makeLibraryService);
