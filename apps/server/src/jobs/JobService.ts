import { Database, Repositories, sql } from "@lumen/database";
import type { ServerConfig } from "../config/Config";
import { Context, Effect, Exit, Layer, Option } from "effect";
import { newUuid } from "../core/Security";
import { MediaIngest } from "../media/MediaIngest";
import { TmdbProvider } from "../media/Tmdb";
import { Scanner } from "../services/Scanner";

export interface JobServiceShape {
  readonly recover: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly runOne: (nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly refresh: (itemId: string, nowMs: number) => Effect.Effect<void, unknown>;
  readonly start: (signal: AbortSignal) => Promise<void>;
}

export const makeJobService = (config?: ServerConfig) => Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const scanner = yield* Scanner;
  const ingest = yield* Effect.serviceOption(MediaIngest);
  const tmdb = yield* Effect.serviceOption(TmdbProvider);

  const refresh: JobServiceShape["refresh"] = Effect.fn("JobService.refresh")(function* (itemId, nowMs) {
    if (!config?.tmdbApiKey) throw new Error("TMDb is not configured");
    const item = yield* database.get<{ libraryId: string }>(sql`SELECT library_id AS libraryId FROM catalog_items WHERE id = ${itemId}`);
    if (item == null) throw new Error("Item not found");
    const sources = yield* database.all<{ sourceId: string }>(sql`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM catalog_items WHERE id = ${itemId}
        UNION ALL SELECT i.id FROM catalog_items i JOIN descendants d ON i.parent_id = d.id
      )
      SELECT DISTINCT s.source_id AS sourceId FROM descendants d JOIN catalog_item_sources s ON s.item_id = d.id
    `);
    if (sources.length === 0) throw new Error("Item has no source");
    const run = yield* repositories.scanning.startRun({ runId: newUuid(), libraryId: item.libraryId, mode: "refresh", startedAtMs: nowMs });
    for (const source of sources) yield* repositories.scanning.createJob({
      id: newUuid(), runId: run.id, parentJobId: null, sourceId: source.sourceId,
      dedupeKey: `metadata:refresh:${source.sourceId}:${nowMs}`, operation: "metadata", priority: 300,
      maxAttempts: 3, availableAtMs: nowMs,
    });
  });

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
    const outcome = yield* Effect.exit(Effect.gen(function* () {
      if (job.operation === "discover") {
        const rootId = job.dedupeKey.slice("discover:".length);
        yield* scanner.discover(job.runId, rootId);
        yield* repositories.scanning.createJob({
          id: newUuid(), runId: job.runId, parentJobId: job.id, sourceId: null, dedupeKey: `cleanup:${rootId}`,
          operation: "cleanup", priority: 200, maxAttempts: 3, availableAtMs: nowMs,
        }).pipe(Effect.catch(() => Effect.void));
      } else if (job.operation === "probe") {
        if (job.sourceId === null) throw new Error("Job has no source");
        if (Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
        if (config?.tmdbApiKey && Option.isSome(tmdb)) {
          const source = yield* database.get<{ libraryId: string }>(sql`SELECT library_id AS libraryId FROM media_sources WHERE id = ${job.sourceId}`);
          if (source != null) {
            const enrichmentRun = yield* repositories.scanning.startRun({ runId: newUuid(), libraryId: source.libraryId, mode: "refresh", startedAtMs: nowMs });
            yield* repositories.scanning.createJob({
              id: newUuid(), runId: enrichmentRun.id, parentJobId: null, sourceId: job.sourceId,
              dedupeKey: `metadata:${job.sourceId}`, operation: "metadata", priority: 100,
              maxAttempts: 3, availableAtMs: nowMs,
            });
          }
        }
      } else if (job.operation === "metadata") {
        if (job.sourceId === null) throw new Error("Job has no source");
        if (Option.isSome(tmdb)) yield* tmdb.value.enrichSource(job.sourceId);
      } else if (job.operation === "cleanup") {
        const rootId = job.dedupeKey.slice("cleanup:".length);
        yield* scanner.cleanup(job.runId, rootId);
      } else if (job.operation === "artwork" || job.operation === "analyze") {
        if (job.sourceId !== null && Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
      }
    }));
    if (Exit.isSuccess(outcome)) {
      yield* database.run(sql`
        UPDATE scan_jobs SET status = 'succeeded', finished_at_ms = ${nowMs}, locked_at_ms = NULL, locked_by = NULL
        WHERE id = ${job.id} AND status = 'running' AND locked_by = ${job.lockedBy}
      `);
      const remaining = yield* database.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM scan_jobs WHERE run_id = ${job.runId} AND status IN ('queued', 'running')
      `);
      if ((remaining?.count ?? 0) === 0) yield* repositories.scanning.finishRun({ runId: job.runId, status: "succeeded", nowMs, errorCode: null, errorMessage: null });
      return true;
    } else {
      const cause = outcome.cause;
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

  return { recover, runOne, refresh, start };
});

export class JobService extends Context.Service<JobService, JobServiceShape>()("@lumen/server/Jobs") {}
export const JobServiceLive = Layer.effect(JobService, makeJobService());
export const JobServiceLiveWithConfig = (config: ServerConfig) => Layer.effect(JobService, makeJobService(config));
