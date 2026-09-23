import { Database, Repositories, sql } from "@lumen/database";
import type { ServerConfig } from "../config/Config";
import { Context, Effect, Layer, Option } from "effect";
import { newUuid } from "../core/Security";
import { MediaIngest } from "../media/MediaIngest";
import { Scanner } from "../services/Scanner";

export interface JobServiceShape {
  readonly recover: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly runOne: (nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly start: (signal: AbortSignal) => Promise<void>;
}

export const makeJobService = (config?: ServerConfig) => Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const scanner = yield* Scanner;
  const ingest = yield* Effect.serviceOption(MediaIngest);

  const recover: JobServiceShape["recover"] = Effect.fn("JobService.recover")(function* (nowMs) {
    const rows = yield* database.all<{ id: string }>(sql`
      SELECT id FROM scan_jobs
      WHERE status = 'running' AND locked_at_ms IS NOT NULL AND locked_at_ms < ${nowMs - (config?.scanLeaseMs ?? 300_000)}
    `);
    for (const row of rows) {
      yield* database.run(sql`
        UPDATE scan_jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          locked_at_ms = NULL, locked_by = NULL, started_at_ms = NULL, finished_at_ms = NULL,
          available_at_ms = ${nowMs}, error_code = 'LEASE_EXPIRED'
        WHERE id = ${row.id} AND status = 'running'
      `);
    }
    return rows.length;
  });

  const runOne: JobServiceShape["runOne"] = Effect.fn("JobService.runOne")(function* (nowMs) {
    const job = yield* repositories.scanning.claimNextJob({ workerId: `server-${newUuid()}`, nowMs, operations: [] });
    if (job === null) return false;
    try {
      if (job.operation === "discover") {
        const rootId = job.dedupeKey.slice("discover:".length);
        yield* scanner.discover(job.runId, rootId);
        yield* repositories.scanning.createJob({
          id: newUuid(), runId: job.runId, parentJobId: job.id, sourceId: null, dedupeKey: `cleanup:${rootId}`,
          operation: "cleanup", priority: 200, maxAttempts: 3, availableAtMs: nowMs,
        }).pipe(Effect.catch(() => Effect.void));
      } else if (job.operation === "probe" || job.operation === "metadata") {
        if (job.sourceId === null) throw new Error("Job has no source");
        if (Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
      } else if (job.operation === "cleanup") {
        const rootId = job.dedupeKey.slice("cleanup:".length);
        yield* scanner.cleanup(job.runId, rootId);
      } else if (job.operation === "artwork" || job.operation === "analyze") {
        if (job.sourceId !== null && Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
      }
      yield* database.run(sql`
        UPDATE scan_jobs SET status = 'succeeded', finished_at_ms = ${nowMs}, locked_at_ms = NULL, locked_by = NULL
        WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.lockedBy}
      `);
      const remaining = yield* database.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM scan_jobs WHERE run_id = ${job.runId} AND status IN ('queued', 'running')
      `);
      if ((remaining?.count ?? 0) === 0) yield* repositories.scanning.finishRun({ runId: job.runId, status: "succeeded", nowMs, errorCode: null, errorMessage: null });
      return true;
    } catch (cause) {
      const retry = job.attempts < job.maxAttempts;
      const delay = Math.min(60_000, 2 ** Math.min(10, job.attempts) * 1_000);
      yield* database.run(sql`
        UPDATE scan_jobs
        SET status = ${retry ? "queued" : "failed"}, available_at_ms = ${nowMs + delay}, finished_at_ms = ${retry ? null : nowMs},
          locked_at_ms = NULL, locked_by = NULL, error_code = 'JOB_FAILED', error_message = ${cause instanceof Error ? cause.message : "Job failed"}
        WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.lockedBy}
      `);
      if (!retry) yield* repositories.scanning.finishRun({ runId: job.runId, status: "failed", nowMs, errorCode: "JOB_FAILED", errorMessage: "A scan job exhausted its retries" }).pipe(Effect.catch(() => Effect.void));
      return true;
    }
  });

  const start = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      await Effect.runPromise(recover(Date.now()).pipe(Effect.catch(() => Effect.void)));
      const didWork = await Effect.runPromise(runOne(Date.now()).pipe(Effect.catch(() => Effect.succeed(false))));
      if (!didWork) await Bun.sleep(100);
    }
  };

  return { recover, runOne, start };
});

export class JobService extends Context.Service<JobService, JobServiceShape>()("@lumen/server/Jobs") {}
export const JobServiceLive = Layer.effect(JobService, makeJobService());
export const JobServiceLiveWithConfig = (config: ServerConfig) => Layer.effect(JobService, makeJobService(config));
