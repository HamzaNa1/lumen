import { Effect } from "../../../packages/database/node_modules/effect/dist/index.js";
import { Database, sql } from "../../../packages/database/src/index.ts";
import { JobService } from "../../../apps/server/src/jobs/JobService";
import { cleanupParkedAtMs } from "../../../apps/server/src/jobs/ScanJobs";

interface NextJob {
  readonly dedupeKey: string;
  readonly attempts: number;
}

/** Drives an isolated scan queue to a terminal run, advancing only to scheduled work. */
export const finishScan = (
  runId: string,
  fromMs: number,
  beforeJob?: (next: NextJob) => Promise<void>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const worker = yield* JobService;
    let nowMs = fromMs;
    for (let step = 0; step < 1_000; step++) {
      const run = yield* db.get<{ status: string }>(
        sql`SELECT status FROM scan_runs WHERE id = ${runId}`,
      );
      if (run === undefined) throw new Error(`Scan ${runId} does not exist`);
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;

      if (beforeJob !== undefined) {
        const next = yield* db.get<NextJob>(sql`
          SELECT dedupe_key AS dedupeKey, attempts FROM scan_jobs
          WHERE status = 'queued' AND available_at_ms <= ${nowMs}
          ORDER BY priority DESC, available_at_ms, id LIMIT 1
        `);
        if (next !== undefined) yield* Effect.promise(() => beforeJob(next));
      }
      if (yield* worker.runOne(nowMs)) continue;

      // Idle only means no job is eligible at nowMs. Parked cleanup has no due
      // time until discovery releases it, so it must never advance this clock.
      const next = yield* db.get<{ availableAtMs: number | null }>(sql`
        SELECT min(available_at_ms) AS availableAtMs FROM scan_jobs
        WHERE run_id = ${runId} AND status = 'queued'
          AND available_at_ms < ${cleanupParkedAtMs}
      `);
      if (next?.availableAtMs == null || next.availableAtMs <= nowMs) {
        const jobs = yield* db.all(sql`
          SELECT operation, status, attempts, available_at_ms FROM scan_jobs
          WHERE run_id = ${runId}
        `);
        throw new Error(`Scan ${runId} stalled at ${nowMs}: ${JSON.stringify(jobs)}`);
      }
      nowMs = next.availableAtMs;
    }
    throw new Error(`Scan ${runId} did not finish within 1000 worker steps`);
  });
