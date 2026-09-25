import type { Library, LibraryGrant, LibraryRoot } from "@lumen/contracts";
import { Database, Repositories, sql } from "@lumen/database";
import { lstat } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, notFound } from "../core/Errors";
import { assertNoRootOverlap, canonicalPath } from "../core/Paths";
import { newUuid } from "../core/Security";
import type { CreateLibraryBody, CreateRootBody, UpdateLibraryBody } from "../http/Schemas";
import type { Schema } from "effect";
import type { CreateGrantBody, StartScanBody } from "../http/Schemas";

type LibraryInput = Schema.Schema.Type<typeof CreateLibraryBody>;
type UpdateLibraryInput = Schema.Schema.Type<typeof UpdateLibraryBody>;
type RootInput = Schema.Schema.Type<typeof CreateRootBody>;
type GrantInput = Schema.Schema.Type<typeof CreateGrantBody>;
type ScanInput = Schema.Schema.Type<typeof StartScanBody>;
type RootRow = Omit<LibraryRoot, "isEnabled"> & { isEnabled: number };
type RootObservation = { readonly id: string; readonly modifiedAtMs: number };

export interface LibraryServiceShape {
  readonly create: (input: LibraryInput, nowMs: number) => Effect.Effect<Library, unknown>;
  readonly update: (libraryId: string, input: UpdateLibraryInput, nowMs: number) => Effect.Effect<unknown, unknown>;
  readonly remove: (libraryId: string) => Effect.Effect<void, unknown>;
  readonly addRoot: (input: RootInput, nowMs: number) => Effect.Effect<LibraryRoot, unknown>;
  readonly listRoots: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryRoot>, unknown>;
  readonly listGrants: (libraryId: string) => Effect.Effect<ReadonlyArray<LibraryGrant>, unknown>;
  readonly deleteRoot: (rootId: string) => Effect.Effect<void, unknown>;
  readonly upsertGrant: (input: GrantInput, nowMs: number) => Effect.Effect<LibraryGrant, unknown>;
  readonly startScan: (input: ScanInput, nowMs: number) => Effect.Effect<{ runId: string }, unknown>;
  readonly startWatchedScan: (input: ScanInput, roots: ReadonlyArray<RootObservation>, nowMs: number) => Effect.Effect<{ runId: string }, unknown>;
}

export const makeLibraryService = Effect.gen(function* () {
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
    return { ...row, kind: input.kind ?? "movies", isEnabled: row?.isEnabled === 1 } as unknown as Library;
  });

  const update: LibraryServiceShape["update"] = Effect.fn("LibraryService.update")(function* (libraryId, input, nowMs) {
    return yield* database.transaction((transaction) => Effect.gen(function* () {
      const row = yield* transaction.get<Record<string, unknown>>(sql`
        UPDATE libraries SET
          name = COALESCE(${input.name?.trim() ?? null}, name),
          slug = COALESCE(${input.slug ?? null}, slug),
          is_enabled = COALESCE(${input.isEnabled === undefined ? null : input.isEnabled ? 1 : 0}, is_enabled),
          updated_at_ms = ${nowMs}
        WHERE id = ${libraryId}
        RETURNING id, name, slug, is_enabled AS isEnabled, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      `);
      if (row == null) return yield* notFound("Library not found");
      const profile = yield* transaction.get<{ kind: "movies" | "shows" | "music" }>(sql`SELECT kind FROM library_profiles WHERE library_id = ${libraryId}`);
      const currentKind = profile?.kind ?? "movies";
      if (input.kind !== undefined && input.kind !== currentKind) {
        const catalog = yield* transaction.get<{ count: number }>(sql`SELECT count(*) AS count FROM catalog_items WHERE library_id = ${libraryId}`);
        if ((catalog?.count ?? 0) > 0) return yield* conflict("Library type cannot change after media has been indexed");
        yield* transaction.run(sql`
          INSERT INTO library_profiles(library_id, kind, scan_mode)
          VALUES (${libraryId}, ${input.kind}, ${input.kind === "music" ? "incremental" : "full"})
          ON CONFLICT(library_id) DO UPDATE SET kind = excluded.kind
        `);
      }
      return { ...row, kind: input.kind ?? currentKind, isEnabled: row.isEnabled === 1 };
    }));
  });

  const remove: LibraryServiceShape["remove"] = Effect.fn("LibraryService.remove")(function* (libraryId) {
    yield* database.run(sql`DELETE FROM libraries WHERE id = ${libraryId}`);
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

  const enqueueScan = Effect.fn("LibraryService.enqueueScan")(function* (
    input: ScanInput,
    nowMs: number,
    observations: ReadonlyArray<RootObservation>,
  ) {
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
      const active = yield* transaction.get<{ id: string }>(sql`
        SELECT id FROM scan_runs
        WHERE library_id = ${input.libraryId} AND status IN ('queued', 'running')
        LIMIT 1
      `);
      if (active != null) return yield* conflict("Library scan is already running");

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
      yield* transaction.run(sql`
        INSERT INTO scan_runs(id, library_id, mode, status, started_at_ms, created_at_ms)
        VALUES (${runId}, ${input.libraryId}, ${input.mode}, 'running', ${nowMs}, ${nowMs})
      `);
      for (const root of enabledRoots) {
        yield* transaction.run(sql`
          INSERT INTO scan_jobs(id, run_id, parent_job_id, source_id, dedupe_key, operation, status, priority, attempts, max_attempts, available_at_ms)
          VALUES (${newUuid()}, ${runId}, NULL, NULL, ${`discover:${root.id}`}, 'discover', 'queued', 100, 0, 3, ${nowMs})
        `);
      }
      for (const observation of observations) {
        yield* transaction.run(sql`
          UPDATE server_library_watch_state
          SET modified_at_ms = ${observation.modifiedAtMs}, checked_at_ms = ${nowMs}
          WHERE root_id = ${observation.id}
        `);
      }
    }));
    return { runId };
  });

  const startScan: LibraryServiceShape["startScan"] = (input, nowMs) => enqueueScan(input, nowMs, []);
  const startWatchedScan: LibraryServiceShape["startWatchedScan"] = (input, roots, nowMs) =>
    enqueueScan(input, nowMs, roots);

  return { create, update, remove, addRoot, listRoots, listGrants, deleteRoot, upsertGrant, startScan, startWatchedScan };
});

export class LibraryService extends Context.Service<LibraryService, LibraryServiceShape>()(
  "@lumen/server/Library",
) {}

export const LibraryServiceLive = Layer.effect(LibraryService, makeLibraryService);
