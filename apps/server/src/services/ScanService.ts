import { Database, libraries, scanJobs, scanRuns } from "@lumen/database";
import { asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { notFound } from "../core/Errors";

export interface ScanServiceShape {
  readonly getRun: (runId: string) => Effect.Effect<unknown, unknown>;
  readonly listJobs: (runId: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly listRecentJobs: (limit: number) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const makeScanService = Effect.gen(function* () {
  const database = yield* Database;
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
    return row;
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
