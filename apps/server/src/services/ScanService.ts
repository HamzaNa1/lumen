import { Database, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { notFound } from "../core/Errors";

export interface ScanServiceShape {
  readonly getRun: (runId: string) => Effect.Effect<unknown, unknown>;
  readonly listJobs: (runId: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const makeScanService = Effect.gen(function* () {
  const database = yield* Database;
  const getRun: ScanServiceShape["getRun"] = Effect.fn("Scans.getRun")(function* (runId) {
    const row = yield* database.get(sql`
      SELECT id, library_id AS libraryId, mode, status, started_at_ms AS startedAtMs, finished_at_ms AS finishedAtMs,
        error_code AS errorCode, error_message AS errorMessage, created_at_ms AS createdAtMs
      FROM scan_runs WHERE id = ${runId}
    `);
    if (row == null) return yield* notFound("Scan run not found");
    return row;
  });
  const listJobs: ScanServiceShape["listJobs"] = Effect.fn("Scans.listJobs")(function* (runId) {
    return yield* database.all(sql`
      SELECT id, run_id AS runId, parent_job_id AS parentJobId, source_id AS sourceId, dedupe_key AS dedupeKey,
        operation, status, priority, attempts, max_attempts AS maxAttempts, available_at_ms AS availableAtMs,
        locked_at_ms AS lockedAtMs, locked_by AS lockedBy, started_at_ms AS startedAtMs, finished_at_ms AS finishedAtMs,
        error_code AS errorCode, error_message AS errorMessage
      FROM scan_jobs WHERE run_id = ${runId} ORDER BY available_at_ms ASC, id ASC
    `);
  });
  return { getRun, listJobs };
});

export class ScanService extends Context.Service<ScanService, ScanServiceShape>()("@lumen/server/Scans") {}
export const ScanServiceLive = Layer.effect(ScanService, makeScanService);
