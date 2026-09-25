import {
  Database,
  libraries,
  scanJobs,
  scanRuns,
  serverScanMissing,
  serverScanSeen,
} from "@lumen/database";
import { and, asc, count, desc, eq, notExists, sql } from "drizzle-orm";
import type { ScanRunStats } from "@lumen/contracts";
import { Context, Effect, Layer } from "effect";
import { notFound } from "../core/Errors";

export interface ScanServiceShape {
  readonly getRun: (runId: string) => Effect.Effect<unknown, unknown>;
  readonly listJobs: (runId: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly listRecentJobs: (limit: number) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const makeScanService = Effect.gen(function* () {
  const database = yield* Database;
  const runStats = Effect.fn("Scans.runStats")(function* (runId: string) {
    const changes = yield* database
      .select({ change: serverScanSeen.change, count: count() })
      .from(serverScanSeen)
      .where(eq(serverScanSeen.runId, runId))
      .groupBy(serverScanSeen.change);
    const byChange = new Map(changes.map((entry) => [entry.change, entry.count]));
    const skipped = yield* database
      .select({ count: count() })
      .from(serverScanSeen)
      .where(
        and(
          eq(serverScanSeen.runId, runId),
          notExists(
            database
              .select({ value: scanJobs.id })
              .from(scanJobs)
              .where(
                and(
                  eq(scanJobs.runId, runId),
                  eq(scanJobs.sourceId, serverScanSeen.sourceId),
                  eq(scanJobs.operation, "probe"),
                ),
              ),
          ),
        ),
      )
      .get();
    const missing = yield* database
      .select({ count: count() })
      .from(serverScanMissing)
      .where(eq(serverScanMissing.runId, runId))
      .get();
    const probes = yield* database
      .select({ count: count() })
      .from(scanJobs)
      .where(and(eq(scanJobs.runId, runId), eq(scanJobs.operation, "probe")))
      .get();
    return {
      discovered: changes.reduce((total, entry) => total + entry.count, 0),
      new: byChange.get("new") ?? 0,
      changed: byChange.get("changed") ?? 0,
      moved: byChange.get("moved") ?? 0,
      unchanged: byChange.get("unchanged") ?? 0,
      skipped: skipped?.count ?? 0,
      missing: missing?.count ?? 0,
      probesEnqueued: probes?.count ?? 0,
    } satisfies ScanRunStats;
  });
  const getRun: ScanServiceShape["getRun"] = Effect.fn("Scans.getRun")(function* (runId) {
    const row = yield* database
      .select({
        id: scanRuns.id,
        libraryId: scanRuns.libraryId,
        mode: scanRuns.mode,
        status: scanRuns.status,
        startedAtMs: scanRuns.startedAtMs,
        finishedAtMs: scanRuns.finishedAtMs,
        errorCode: scanRuns.errorCode,
        errorMessage: scanRuns.errorMessage,
        createdAtMs: scanRuns.createdAtMs,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, runId))
      .get();
    if (row == null) return yield* notFound("Scan run not found");
    return { ...row, stats: yield* runStats(runId) };
  });
  const listJobs: ScanServiceShape["listJobs"] = Effect.fn("Scans.listJobs")(function* (runId) {
    return yield* database
      .select()
      .from(scanJobs)
      .where(eq(scanJobs.runId, runId))
      .orderBy(asc(scanJobs.availableAtMs), asc(scanJobs.id));
  });
  const listRecentJobs: ScanServiceShape["listRecentJobs"] = Effect.fn("Scans.listRecentJobs")(
    function* (limit) {
      return yield* database
        .select({
          id: scanJobs.id,
          runId: scanJobs.runId,
          libraryId: scanRuns.libraryId,
          libraryName: libraries.name,
          mode: scanRuns.mode,
          operation: scanJobs.operation,
          status: scanJobs.status,
          attempts: scanJobs.attempts,
          maxAttempts: scanJobs.maxAttempts,
          availableAtMs: scanJobs.availableAtMs,
          startedAtMs: scanJobs.startedAtMs,
          finishedAtMs: scanJobs.finishedAtMs,
          errorCode: scanJobs.errorCode,
          errorMessage: scanJobs.errorMessage,
        })
        .from(scanJobs)
        .innerJoin(scanRuns, eq(scanRuns.id, scanJobs.runId))
        .innerJoin(libraries, eq(libraries.id, scanRuns.libraryId))
        .orderBy(
          desc(sql`coalesce(${scanJobs.startedAtMs}, ${scanJobs.availableAtMs})`),
          desc(scanJobs.id),
        )
        .limit(limit);
    },
  );
  return { getRun, listJobs, listRecentJobs };
});

export class ScanService extends Context.Service<ScanService, ScanServiceShape>()(
  "@lumen/server/Scans",
) {}
export const ScanServiceLive = Layer.effect(ScanService, makeScanService);
