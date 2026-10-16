import { Effect } from "../../../packages/database/node_modules/effect/dist/index.js";
import { Database, sql } from "../../../packages/database/src/index.ts";
import { JobService } from "../../../apps/server/src/jobs/JobService";
import { cleanupParkedAtMs } from "../../../apps/server/src/jobs/ScanJobs";

interface NextJob {
  readonly id: string;
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
    for (;;) {
      const run = yield* db.get<{ status: string }>(
        sql`SELECT status FROM scan_runs WHERE id = ${runId}`,
      );
      if (run === undefined) throw new Error(`Scan ${runId} does not exist`);
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;

      const eligible = yield* db.get<NextJob>(sql`
        SELECT id, dedupe_key AS dedupeKey, attempts FROM scan_jobs
        WHERE status = 'queued' AND available_at_ms <= ${nowMs}
        ORDER BY priority DESC, available_at_ms, id LIMIT 1
      `);
      if (eligible !== undefined && beforeJob !== undefined)
        yield* Effect.promise(() => beforeJob(eligible));
      if (yield* worker.runOne(nowMs)) {
        if (eligible === undefined)
          throw new Error(`Scan ${runId}: worker reported work without an eligible scan job`);
        const attempted = yield* db.get<{ attempts: number }>(
          sql`SELECT attempts FROM scan_jobs WHERE id = ${eligible.id}`,
        );
        // Progress is a claimed attempt (or a job removed by reconciliation),
        // not a fixed number of dispatches. The test timeout bounds total time.
        if (attempted !== undefined && attempted.attempts <= eligible.attempts)
          throw new Error(`Scan ${runId}: worker did not advance job ${eligible.id}`);
        continue;
      }

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
  });
