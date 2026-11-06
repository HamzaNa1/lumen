import {
  type DatabaseClient,
  type DatabaseTransaction,
  scanJobs,
  scanRuns,
  serverScanMissing,
  serverScanSeen,
} from "@lumen/database";
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { scanRunStats } from "../services/ScanStatistics";

const dayMs = 24 * 60 * 60 * 1_000;
const jobRetentionMs = 7 * dayMs;
const runRetentionMs = 30 * dayMs;
const batchSize = 200;
const terminalStatuses = ["succeeded", "failed", "cancelled"];

// A terminal status alone is not enough for old or interrupted installations:
// leave any run containing queued or leased work untouched.
const settled = () =>
  and(
    inArray(scanRuns.status, terminalStatuses),
    isNotNull(scanRuns.finishedAtMs),
    sql`not exists (select 1 from ${scanJobs} where ${scanJobs.runId} = ${scanRuns.id}
      and ${scanJobs.status} in ('queued', 'running'))`,
  );

const pruneFiles = (transaction: DatabaseTransaction, nowMs: number) =>
  Effect.gen(function* () {
    const [run] = yield* transaction
      .select({ id: scanRuns.id, stats: scanRuns.stats })
      .from(scanRuns)
      .where(and(settled(), isNull(scanRuns.filesPrunedAtMs), lte(scanRuns.finishedAtMs, nowMs)))
      .orderBy(asc(scanRuns.finishedAtMs), asc(scanRuns.id))
      .limit(1);
    if (run === undefined) return 0;
    // Legacy terminal runs acquire their snapshot before the first detail is removed.
    if (run.stats === null) {
      const stats = yield* scanRunStats(transaction, run.id);
      yield* transaction.update(scanRuns).set({ stats }).where(eq(scanRuns.id, run.id));
    }
    let removed = 0;
    for (const table of [serverScanSeen, serverScanMissing]) {
      const rows = yield* transaction.all(sql`
        delete from ${table} where rowid in (
          select rowid from ${table} where ${table.runId} = ${run.id} limit ${batchSize - removed}
        ) returning rowid`);
      removed += rows.length;
    }
    if (removed < batchSize) {
      yield* transaction
        .update(scanRuns)
        .set({ filesPrunedAtMs: nowMs })
        .where(eq(scanRuns.id, run.id));
    }
    return 1;
  });

const pruneJobs = (transaction: DatabaseTransaction, nowMs: number) =>
  Effect.gen(function* () {
    const [run] = yield* transaction
      .select({ id: scanRuns.id })
      .from(scanRuns)
      .where(
        and(
          settled(),
          isNotNull(scanRuns.stats),
          isNotNull(scanRuns.filesPrunedAtMs),
          isNull(scanRuns.jobsPrunedAtMs),
          lte(scanRuns.finishedAtMs, nowMs - jobRetentionMs),
        ),
      )
      .orderBy(asc(scanRuns.finishedAtMs), asc(scanRuns.id))
      .limit(1);
    if (run === undefined) return 0;
    // Only leaves are removed: the parent FK's cascade must not expand a batch.
    yield* transaction.all(sql`
      delete from ${scanJobs} where ${scanJobs.id} in (
        select candidate.id from scan_jobs candidate where candidate.run_id = ${run.id}
          and not exists (select 1 from scan_jobs child where child.parent_job_id = candidate.id)
        limit ${batchSize}
      ) returning id`);
    const [remaining] = yield* transaction
      .select({ id: scanJobs.id })
      .from(scanJobs)
      .where(eq(scanJobs.runId, run.id))
      .limit(1);
    if (remaining === undefined) {
      yield* transaction
        .update(scanRuns)
        .set({ jobsPrunedAtMs: nowMs })
        .where(eq(scanRuns.id, run.id));
    }
    return 1;
  });

const pruneRuns = (transaction: DatabaseTransaction, nowMs: number) =>
  Effect.gen(function* () {
    const runs = yield* transaction
      .select({ id: sql<string>`${scanRuns.id}` })
      // Prefer the expiry range over the broad terminal-status index on legacy databases.
      .from(sql`${scanRuns} indexed by scan_runs_finished_idx`)
      .where(
        and(
          settled(),
          isNotNull(scanRuns.stats),
          isNotNull(scanRuns.filesPrunedAtMs),
          isNotNull(scanRuns.jobsPrunedAtMs),
          lte(scanRuns.finishedAtMs, nowMs - runRetentionMs),
          sql`not exists (select 1 from ${scanJobs} where ${scanJobs.runId} = ${scanRuns.id})`,
          sql`not exists (select 1 from ${serverScanSeen} where ${serverScanSeen.runId} = ${scanRuns.id})`,
          sql`not exists (select 1 from ${serverScanMissing} where ${serverScanMissing.runId} = ${scanRuns.id})`,
        ),
      )
      .orderBy(asc(scanRuns.finishedAtMs), asc(scanRuns.id))
      .limit(batchSize);
    if (runs.length === 0) return 0;
    yield* transaction.delete(scanRuns).where(
      inArray(
        scanRuns.id,
        runs.map((run) => run.id),
      ),
    );
    return runs.length;
  });

/** Each committed batch is its own checkpoint; a restart simply selects unfinished work. */
export const pruneScanHistory = Effect.fn("ScanHistory.prune")(function* (
  database: DatabaseClient,
  nowMs: number,
) {
  const deadline = performance.now() + 1_000;
  let batches = 0;
  // Rotate phases so a large legacy file backlog does not starve job/run retention.
  for (let pass = 0; pass < 100; pass += 1) {
    let progressed = false;
    for (const prune of [pruneFiles, pruneJobs, pruneRuns]) {
      const count = yield* database.transaction((transaction) => prune(transaction, nowMs));
      progressed ||= count > 0;
      batches += 1;
      if (performance.now() >= deadline) return batches;
      yield* Effect.sleep(1);
    }
    if (!progressed) break;
  }
  return batches;
});
