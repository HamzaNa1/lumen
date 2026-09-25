import { Database, sql } from "@lumen/database";
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
  const listRecentJobs: ScanServiceShape["listRecentJobs"] = Effect.fn("Scans.listRecentJobs")(function* (limit) {
    return yield* database.all(sql`
      SELECT job.id, job.run_id AS runId, run.library_id AS libraryId, library.name AS libraryName,
        run.mode, job.operation, job.status, job.attempts, job.max_attempts AS maxAttempts,
        job.available_at_ms AS availableAtMs, job.started_at_ms AS startedAtMs,
        job.finished_at_ms AS finishedAtMs, job.error_code AS errorCode, job.error_message AS errorMessage
      FROM scan_jobs job
      JOIN scan_runs run ON run.id = job.run_id
      JOIN libraries library ON library.id = run.library_id
      ORDER BY COALESCE(job.started_at_ms, job.available_at_ms) DESC, job.id DESC
      LIMIT ${limit}
    `);
  });
  return { getRun, listJobs, listRecentJobs };
});

export class ScanService extends Context.Service<ScanService, ScanServiceShape>()("@lumen/server/Scans") {}
export const ScanServiceLive = Layer.effect(ScanService, makeScanService);
