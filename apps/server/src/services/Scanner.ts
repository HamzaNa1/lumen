import { lstat } from "node:fs/promises";
import {
  catalogItemOrigins,
  catalogItemSources,
  Database,
  libraries,
  libraryRootStates,
  libraryRoots,
  mediaSourceAvailability,
  mediaSources,
  scanJobs,
  scanRuns,
  streams,
} from "@lumen/database";
import { and, eq, exists, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ServerLogger } from "../core/Logger";
import { newUuid } from "../core/Security";
import { type ClaimedScanJob, insertJobs, insertScanRun } from "../jobs/ScanJobs";
import { purgeSources } from "./CatalogPurge";
import { diff, hasChanges, type ReconcilePlan, type ScanMode } from "./LibraryDiff";
import { observeRoot } from "./LibraryObservation";

export interface PreparedReconciliation {
  readonly libraryId: string;
  readonly revision: number;
  readonly plan: ReconcilePlan;
  readonly sourceIds: ReadonlyMap<string, string>;
}

type ApplyResult = "applied" | "stale" | "inactive";
export interface ScannerShape {
  readonly prepare: (
    libraryId: string,
    mode: ScanMode,
  ) => Effect.Effect<PreparedReconciliation | null, unknown>;
  readonly apply: (
    prepared: PreparedReconciliation,
    nowMs: number,
    job?: ClaimedScanJob,
  ) => Effect.Effect<ApplyResult, unknown>;
  readonly reconcile: (
    libraryId: string,
    nowMs: number,
    job?: ClaimedScanJob,
  ) => Effect.Effect<boolean, unknown>;
}

// Keep reappeared regular files and paths whose existence cannot be checked.
// Symlinks and other non-files are not catalog sources.
const stillMissing = async (path: string): Promise<boolean> => {
  try {
    return !(await lstat(path)).isFile();
  } catch (cause) {
    return ["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "");
  }
};

export const makeScanner = Effect.gen(function* () {
  const database = yield* Database;
  const logger = (yield* ServerLogger).child({ component: "scanner" });
  const ingestIncomplete = or(
    isNull(mediaSources.contentFingerprint),
    notExists(
      database
        .select({ value: catalogItemSources.itemId })
        .from(catalogItemSources)
        .where(eq(catalogItemSources.sourceId, mediaSources.id)),
    ),
    exists(
      database
        .select({ value: streams.id })
        .from(streams)
        .where(and(eq(streams.sourceId, mediaSources.id), isNull(streams.ordinal))),
    ),
  );

  const prepare: ScannerShape["prepare"] = Effect.fn("Scanner.prepare")(
    function* (libraryId, mode) {
      // Capture the root configuration before walking; a change during observation invalidates it.
      const configuration = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const library = yield* transaction
            .select({ revision: libraries.scanRevision })
            .from(libraries)
            .where(and(eq(libraries.id, libraryId), eq(libraries.isEnabled, true)))
            .get();
          if (library === undefined) return null;
          const roots = yield* transaction
            .select({
              id: libraryRoots.id,
              path: libraryRoots.path,
              isAvailable: libraryRootStates.isAvailable,
              unavailableReason: libraryRootStates.unavailableReason,
            })
            .from(libraryRoots)
            .innerJoin(libraryRootStates, eq(libraryRootStates.rootId, libraryRoots.id))
            .where(and(eq(libraryRoots.libraryId, libraryId), eq(libraryRoots.isEnabled, true)));
          return { ...library, roots };
        }),
      );
      if (configuration === null) return null;
      const observations = yield* Effect.tryPromise(() =>
        Promise.all(
          configuration.roots.map((root) =>
            observeRoot(root, (path, cause) =>
              logger.warn("scan_path_unreadable", { libraryId, path }, cause),
            ),
          ),
        ),
      );
      const snapshot = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const library = yield* transaction
            .select({ revision: libraries.scanRevision })
            .from(libraries)
            .where(eq(libraries.id, libraryId))
            .get();
          const sources = yield* transaction
            .select({
              id: mediaSources.id,
              rootId: mediaSources.rootId,
              absolutePath: mediaSources.absolutePath,
              relativePath: mediaSources.relativePath,
              fileSizeBytes: mediaSources.fileSizeBytes,
              modifiedAtMs: mediaSources.modifiedAtMs,
              inode: mediaSources.inode,
              device: mediaSources.device,
              isAvailable: mediaSourceAvailability.isAvailable,
            })
            .from(mediaSources)
            .leftJoin(
              mediaSourceAvailability,
              eq(mediaSourceAvailability.sourceId, mediaSources.id),
            )
            .where(eq(mediaSources.libraryId, libraryId));
          const incomplete = yield* transaction
            .select({ id: mediaSources.id })
            .from(mediaSources)
            .where(and(eq(mediaSources.libraryId, libraryId), ingestIncomplete));
          return {
            revision: library?.revision,
            sources,
            incomplete: new Set(incomplete.map((source) => source.id)),
            roots: configuration.roots,
          };
        }),
      );
      // Keep the old revision so apply rejects a snapshot from a newer root configuration.
      const plan = diff(observations, snapshot, mode);
      const sourceIds = new Map(snapshot.sources.map((source) => [source.absolutePath, source.id]));
      for (const move of plan.moves) sourceIds.set(move.file.absolutePath, move.source.id);
      for (const file of plan.inserts) sourceIds.set(file.absolutePath, newUuid());
      return { libraryId, revision: configuration.revision, plan, sourceIds };
    },
  );

  const apply: ScannerShape["apply"] = Effect.fn("Scanner.apply")(function* (prepared, nowMs, job) {
    const { libraryId, revision, plan, sourceIds } = prepared;
    return yield* database
      .transaction((transaction) =>
        Effect.gen(function* () {
          // The first write obtains SQLite's write lock and fences every following mutation.
          const [updated] = yield* transaction
            .update(libraries)
            .set({ scanRevision: sql`${libraries.scanRevision} + 1` })
            .where(
              and(
                eq(libraries.id, libraryId),
                eq(libraries.scanRevision, revision),
                eq(libraries.isEnabled, true),
              ),
            )
            .returning({ id: libraries.id });
          if (updated === undefined) return "stale" as const;
          if (job !== undefined) {
            const owned = yield* transaction
              .select({ id: scanJobs.id })
              .from(scanJobs)
              .where(
                and(
                  eq(scanJobs.id, job.id),
                  eq(scanJobs.status, "running"),
                  eq(scanJobs.lockedBy, job.lockedBy ?? ""),
                ),
              )
              .get();
            if (owned === undefined) return yield* Effect.fail(new Error("Discovery lease lost"));
          } else {
            const active = yield* transaction
              .select({ id: scanRuns.id })
              .from(scanRuns)
              .where(
                and(
                  eq(scanRuns.libraryId, libraryId),
                  inArray(scanRuns.status, ["queued", "running"]),
                ),
              )
              .get();
            if (active !== undefined) return yield* Effect.fail(new ActiveScan());
          }
          const runId = job?.runId ?? newUuid();
          if (job === undefined) {
            yield* insertScanRun(
              transaction,
              { runId, libraryId, mode: "incremental", jobs: [] },
              nowMs,
            );
            yield* transaction.insert(scanJobs).values({
              id: newUuid(),
              runId,
              dedupeKey: `discover:${libraryId}`,
              operation: "discover",
              status: "succeeded",
              availableAtMs: nowMs,
              startedAtMs: nowMs,
              finishedAtMs: nowMs,
              attempts: 1,
            });
          }
          for (let offset = 0; offset < plan.inserts.length; offset += 250) {
            const batch = plan.inserts.slice(offset, offset + 250);
            yield* transaction.insert(mediaSources).values(
              batch.map((file) => ({
                ...file,
                id: sourceIds.get(file.absolutePath) as string,
                libraryId,
                kind: "local",
                scannedAtMs: nowMs,
              })),
            );
          }
          for (const { source, file, changed } of plan.updates) {
            yield* transaction
              .update(mediaSources)
              .set({
                ...file,
                ...(changed ? { contentFingerprint: null } : {}),
                scannedAtMs: nowMs,
              })
              .where(eq(mediaSources.id, source.id));
          }
          for (const { source, file } of plan.moves) {
            yield* transaction
              .update(catalogItemOrigins)
              .set({ rootId: file.rootId, relativePath: file.relativePath })
              .where(
                inArray(
                  catalogItemOrigins.itemId,
                  transaction
                    .select({ itemId: catalogItemSources.itemId })
                    .from(catalogItemSources)
                    .where(eq(catalogItemSources.sourceId, source.id)),
                ),
              );
          }
          const available = [...plan.inserts, ...plan.updates.map((update) => update.file)];
          for (let offset = 0; offset < available.length; offset += 250) {
            yield* transaction
              .insert(mediaSourceAvailability)
              .values(
                available.slice(offset, offset + 250).map((file) => ({
                  sourceId: sourceIds.get(file.absolutePath) as string,
                  isAvailable: true,
                  lastSeenAtMs: nowMs,
                  missingSinceMs: null,
                  updatedAtMs: nowMs,
                })),
              )
              .onConflictDoUpdate({
                target: mediaSourceAvailability.sourceId,
                set: {
                  isAvailable: true,
                  lastSeenAtMs: nowMs,
                  missingSinceMs: null,
                  updatedAtMs: nowMs,
                },
              });
          }
          for (const root of plan.availability)
            yield* transaction
              .update(libraryRootStates)
              .set({
                isAvailable: root.reason === null,
                unavailableReason: root.reason,
                ...(root.reason === null ? { lastSeenAtMs: nowMs } : {}),
                updatedAtMs: nowMs,
              })
              .where(eq(libraryRootStates.rootId, root.rootId));
          yield* insertJobs(
            transaction,
            runId,
            plan.probes.map((file) => {
              const sourceId = sourceIds.get(file.absolutePath) as string;
              return {
                sourceId,
                dedupeKey: `probe:${sourceId}`,
                operation: "probe",
                priority: 500,
                maxAttempts: 5,
              };
            }),
            nowMs,
          );
          const missing = [];
          for (const source of plan.missing)
            if (yield* Effect.promise(() => stillMissing(source.absolutePath)))
              missing.push(source);
          yield* purgeSources(
            transaction,
            missing.map((source) => source.id),
          );
          yield* transaction
            .update(scanRuns)
            .set({
              stats: {
                ...plan.stats,
                missing: missing.filter((source) => source.isAvailable !== false).length,
              },
            })
            .where(and(eq(scanRuns.id, runId), isNull(scanRuns.stats)));
          if (job === undefined && plan.probes.length === 0)
            yield* transaction
              .update(scanRuns)
              .set({ status: "succeeded", finishedAtMs: nowMs })
              .where(eq(scanRuns.id, runId));
          return "applied" as const;
        }),
      )
      .pipe(
        Effect.catchIf(
          (cause) => cause instanceof ActiveScan,
          () => Effect.succeed("inactive" as const),
        ),
      );
  });

  const reconcile: ScannerShape["reconcile"] = Effect.fn("Scanner.reconcile")(
    function* (libraryId, nowMs, job) {
      const run =
        job === undefined
          ? undefined
          : yield* database
              .select({ mode: scanRuns.mode, stats: scanRuns.stats })
              .from(scanRuns)
              .where(eq(scanRuns.id, job.runId))
              .get();
      // A crash after commit but before job completion must not repeat a full scan or replace its stats.
      if (run?.stats != null) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = yield* prepare(libraryId, {
          mode: run?.mode === "full" ? "full" : "incremental",
          userInitiated: job !== undefined,
        });
        if (prepared === null) return false;
        const current = yield* database
          .select({ revision: libraries.scanRevision })
          .from(libraries)
          .where(eq(libraries.id, libraryId))
          .get();
        if (current?.revision !== prepared.revision) continue;
        if (job === undefined && !hasChanges(prepared.plan)) return false;
        const result = yield* apply(prepared, nowMs, job);
        if (result !== "stale") return result === "applied";
      }
      logger.warn("scan_plan_stale", { libraryId });
      return false;
    },
  );
  return { prepare, apply, reconcile };
});

class ActiveScan extends Error {}
export class Scanner extends Context.Service<Scanner, ScannerShape>()("@lumen/server/Scanner") {}
export const ScannerLive = Layer.effect(Scanner, makeScanner);
