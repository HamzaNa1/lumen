import { CreateLibrary, type Library, type LibraryGrant, type LibraryRoot } from "@lumen/contracts";
import { Database, Repositories, sql } from "@lumen/database";
import { lstat } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, notFound } from "../core/Errors";
import { assertNoRootOverlap, canonicalPath } from "../core/Paths";
import { newUuid } from "../core/Security";
import type { CreateLibraryBody, CreateRootBody } from "../http/Schemas";
import { Schema } from "effect";
import type { ServerConfig } from "../config/Config";
import { isAbsolute, relative, sep } from "node:path";
import type { CreateGrantBody, StartScanBody } from "../http/Schemas";

type LibraryInput = Schema.Schema.Type<typeof CreateLibraryBody>;
type RootInput = Schema.Schema.Type<typeof CreateRootBody>;
type GrantInput = Schema.Schema.Type<typeof CreateGrantBody>;
type ScanInput = Schema.Schema.Type<typeof StartScanBody>;
type RootRow = Omit<LibraryRoot, "isEnabled"> & { isEnabled: number };

export interface LibraryServiceShape {
  readonly create: (input: LibraryInput, nowMs: number) => Effect.Effect<Library, unknown>;
  readonly addRoot: (input: RootInput, nowMs: number) => Effect.Effect<LibraryRoot, unknown>;
  readonly listRoots: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryRoot>, unknown>;
  readonly listGrants: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryGrant>, unknown>;
  readonly deleteRoot: (rootId: string) => Effect.Effect<void, unknown>;
  readonly upsertGrant: (input: GrantInput, nowMs: number) => Effect.Effect<LibraryGrant, unknown>;
  readonly startScan: (input: ScanInput, nowMs: number) => Effect.Effect<{ runId: string }, unknown>;
}

export const makeLibraryService = (config: ServerConfig) => Effect.gen(function* () {
  const repositories = yield* Repositories;
  const database = yield* Database;

  const create: LibraryServiceShape["create"] = Effect.fn("LibraryService.create")(function* (input, nowMs) {
    const row = yield* database.transaction((transaction) => Effect.gen(function* () {
      const created = yield* transaction.get<Record<string, unknown>>(sql`
        INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms)
        VALUES (${input.id}, ${input.name}, ${input.slug}, 1, ${nowMs}, ${nowMs})
        RETURNING id, name, slug, is_enabled AS isEnabled, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      `);
      yield* transaction.run(sql`
        INSERT INTO library_profiles(library_id, kind, scan_mode)
        VALUES (${input.id}, ${input.kind ?? "movies"}, ${input.kind === "music" ? "incremental" : "full"})
      `);
      return created;
    }));
    return { ...row, isEnabled: row?.isEnabled === 1 } as Library;
  });

  const addRoot: LibraryServiceShape["addRoot"] = Effect.fn("LibraryService.addRoot")(function* (input, nowMs) {
    const library = yield* database.get<{ isEnabled: number }>(sql`
      SELECT is_enabled AS isEnabled FROM libraries WHERE id = ${input.libraryId}
    `);
    if (library == null) return yield* conflict("Library does not exist");
    if (library.isEnabled !== 1) return yield* conflict("Library is disabled");
    const rootPath = yield* Effect.tryPromise({
      try: () => canonicalPath(input.path),
      catch: (cause) => conflict(cause instanceof Error ? cause.message : "Root does not exist"),
    });
    const allowed = config.allowedMediaBases.length === 0 || config.allowedMediaBases.some((base) => {
      const resolvedBase = relative(base, rootPath);
      return resolvedBase === "" || (resolvedBase !== ".." && !resolvedBase.startsWith(`..${sep}`) && !isAbsolute(resolvedBase));
    });
    if (!allowed) return yield* conflict("Root is outside the configured media base directories");
    const stat = yield* Effect.tryPromise({
      try: () => lstat(rootPath),
      catch: () => conflict("Root is not accessible"),
    });
    if (!stat.isDirectory()) return yield* conflict("Root must be a directory");
    const roots = yield* database.all<{ path: string }>(sql`SELECT path FROM library_roots`);
    yield* assertNoRootOverlap(roots.map((root) => root.path), rootPath);
    const canonicalKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    const row = yield* database.transaction((transaction) => Effect.gen(function* () {
      const created = yield* transaction.get<Record<string, unknown>>(sql`
        INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms)
        VALUES (${input.id}, ${input.libraryId}, ${rootPath}, 1, ${input.priority}, ${nowMs}, ${nowMs})
        RETURNING id, library_id AS libraryId, path, is_enabled AS isEnabled, priority, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      `);
      yield* transaction.run(sql`
        INSERT INTO library_root_states(root_id, library_id, canonical_path, canonical_key, is_available, scan_generation, updated_at_ms)
        VALUES (${input.id}, ${input.libraryId}, ${rootPath}, ${canonicalKey}, 1, 0, ${nowMs})
      `);
      return created;
    }));
    return { ...row, isEnabled: row?.isEnabled === 1 } as LibraryRoot;
  });

  const listRoots: LibraryServiceShape["listRoots"] = Effect.fn("LibraryService.listRoots")(function* (libraryId) {
    const rows = yield* database.all<RootRow & { isAvailable: number; unavailableReason: string | null }>(sql`
      SELECT r.id, r.library_id AS libraryId, r.path, r.is_enabled AS isEnabled, r.priority, r.created_at_ms AS createdAtMs, r.updated_at_ms AS updatedAtMs,
        COALESCE(rs.is_available, 1) AS isAvailable, rs.unavailable_reason AS unavailableReason
      FROM library_roots r LEFT JOIN library_root_states rs ON rs.root_id = r.id
      WHERE r.library_id = ${libraryId} ORDER BY r.priority ASC, r.path ASC
    `);
    return rows.map((row) => ({ ...row, isEnabled: row.isEnabled === 1, isAvailable: row.isAvailable === 1 }));
  });

  const listGrants: LibraryServiceShape["listGrants"] = Effect.fn("LibraryService.listGrants")(function* (libraryId) {
    return yield* repositories.libraries.listGrants({ libraryId }).pipe(Effect.mapError(mapRepositoryError));
  });

  const deleteRoot: LibraryServiceShape["deleteRoot"] = Effect.fn("LibraryService.deleteRoot")(function* (rootId) {
    yield* database.run(sql`DELETE FROM library_roots WHERE id = ${rootId}`);
  });

  const upsertGrant: LibraryServiceShape["upsertGrant"] = Effect.fn("LibraryService.upsertGrant")(function* (input, nowMs) {
    return yield* repositories.libraries.upsertGrant({ ...input, nowMs }).pipe(Effect.mapError(mapRepositoryError));
  });

  const startScan: LibraryServiceShape["startScan"] = Effect.fn("LibraryService.startScan")(function* (input, nowMs) {
    const library = yield* database.get<{ isEnabled: number }>(sql`
      SELECT is_enabled AS isEnabled FROM libraries WHERE id = ${input.libraryId}
    `);
    if (library == null || library.isEnabled !== 1) return yield* conflict("Library is disabled");
    const roots = yield* database.all<RootRow>(sql`
      SELECT id, library_id AS libraryId, path, is_enabled AS isEnabled, priority, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      FROM library_roots WHERE library_id = ${input.libraryId} AND is_enabled = 1 ORDER BY priority ASC, path ASC
    `);
    const enabledRoots = roots.map((root) => ({ ...root, isEnabled: root.isEnabled === 1 }));
    if (enabledRoots.length === 0) return yield* conflict("Library has no enabled roots");
    const runId = newUuid();
    yield* database.transaction((transaction) => Effect.gen(function* () {
      for (const root of enabledRoots) {
        yield* transaction.run(sql`
          INSERT INTO server_scan_state(root_id, generation, updated_at_ms)
          VALUES (${root.id}, 1, ${nowMs})
          ON CONFLICT(root_id) DO UPDATE SET generation = generation + 1, updated_at_ms = excluded.updated_at_ms
        `);
        yield* transaction.run(sql`
          UPDATE library_root_states SET scan_generation = scan_generation + 1, updated_at_ms = ${nowMs}
          WHERE root_id = ${root.id}
        `);
      }
    }));
    const run = yield* repositories.scanning.startRun({ runId, libraryId: input.libraryId, mode: input.mode, startedAtMs: nowMs }).pipe(Effect.mapError(mapRepositoryError));
    for (const root of enabledRoots) {
      yield* repositories.scanning.createJob({
        id: newUuid(),
        runId: run.id,
        parentJobId: null,
        sourceId: null,
        dedupeKey: `discover:${root.id}`,
        operation: "discover",
        priority: 100,
        maxAttempts: 3,
        availableAtMs: nowMs,
      }).pipe(Effect.mapError(mapRepositoryError));
    }
    return { runId: run.id };
  });

  return { create, addRoot, listRoots, listGrants, deleteRoot, upsertGrant, startScan };
});

export class LibraryService extends Context.Service<LibraryService, LibraryServiceShape>()(
  "@lumen/server/Library",
) {}

export const LibraryServiceLive = (config: ServerConfig) => Layer.effect(LibraryService, makeLibraryService(config));
