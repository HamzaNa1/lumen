import { type DatabaseClient, type DatabaseTransaction, scanJobs, scanRuns } from "@lumen/database";
import { and, asc, count, eq, inArray, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { newUuid } from "../core/Security";
import { retryDelayMs } from "./ServerJobs";

// Library scan work stored in `scan_runs` and `scan_jobs`. A run is active while
// any of its jobs can still run. Every job outcome is written in one transaction
// with what it implies for the run, so a crash cannot leave an active run whose
// jobs have all ended.

// Cleanup jobs wait at this availability until settleCleanups releases them.
export const cleanupParkedAtMs = Number.MAX_SAFE_INTEGER;

type ScanJobOperation = "discover" | "probe" | "artwork" | "metadata" | "analyze" | "cleanup";
type FinishedRunStatus = "succeeded" | "failed" | "cancelled";

const activeStatuses = ["queued", "running"];
const insertChunkSize = 500;

export interface NewScanJob {
  readonly parentJobId?: string | null;
  readonly sourceId: string | null;
  readonly dedupeKey: string;
  readonly operation: ScanJobOperation;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly availableAtMs?: number;
}

export interface NewScanRun {
  readonly runId: string;
  readonly libraryId: string;
  readonly mode: "full" | "incremental" | "refresh";
  readonly jobs: ReadonlyArray<NewScanJob>;
}

/** Work a succeeded job hands on, written together with its success. */
export interface ScanJobFollowUp {
  /** Jobs added to the finished job's own run. */
  readonly jobs: ReadonlyArray<NewScanJob>;
  /** Independent runs started because of the finished job. */
  readonly runs: ReadonlyArray<NewScanRun>;
}

export const noFollowUp: ScanJobFollowUp = { jobs: [], runs: [] };

export interface ClaimedScanJob {
  readonly id: string;
  readonly runId: string;
  readonly operation: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lockedBy: string | null;
}

export interface FinishedScanRun {
  readonly runId: string;
  readonly status: FinishedRunStatus;
}

export interface ScanRunSettlement {
  /** Parked cleanups cancelled because a discovery in the run failed. */
  readonly cleanupsCancelled: number;
  /** The run, when this settlement ended it. */
  readonly run: FinishedScanRun | null;
}

export interface ScanJobSettlement extends ScanRunSettlement {
  /** False when another worker took the job over; nothing was written. */
  readonly owned: boolean;
}

const unsettled: ScanRunSettlement = { cleanupsCancelled: 0, run: null };
const notOwned: ScanJobSettlement = { owned: false, ...unsettled };

const insertJobs = Effect.fn("ScanJobs.insertJobs")(function* (
  transaction: DatabaseTransaction,
  runId: string,
  jobs: ReadonlyArray<NewScanJob>,
  nowMs: number,
) {
  for (let offset = 0; offset < jobs.length; offset += insertChunkSize) {
    yield* transaction
      .insert(scanJobs)
      .values(
        jobs.slice(offset, offset + insertChunkSize).map((job) => ({
          id: newUuid(),
          runId,
          parentJobId: job.parentJobId ?? null,
          sourceId: job.sourceId,
          dedupeKey: job.dedupeKey,
          operation: job.operation,
          priority: job.priority,
          maxAttempts: job.maxAttempts,
          availableAtMs: job.availableAtMs ?? nowMs,
        })),
      )
      .onConflictDoNothing({ target: [scanJobs.runId, scanJobs.dedupeKey] });
  }
});

/** Starts a run together with its first jobs: a run is never active without work. */
export const insertScanRun = Effect.fn("ScanJobs.insertRun")(function* (
  transaction: DatabaseTransaction,
  run: NewScanRun,
  nowMs: number,
) {
  yield* transaction.insert(scanRuns).values({
    id: run.runId,
    libraryId: run.libraryId,
    mode: run.mode,
    status: "running",
    startedAtMs: nowMs,
    createdAtMs: nowMs,
  });
  yield* insertJobs(transaction, run.runId, run.jobs, nowMs);
});

// A source moved between roots is only matched once the destination root is
// discovered, so cleanups stay parked until every discovery in the run ends.
// If any discovery failed, a moved source may be unmatched: delete nothing.
const settleCleanups = Effect.fn("ScanJobs.settleCleanups")(function* (
  transaction: DatabaseTransaction,
  runId: string,
  nowMs: number,
) {
  const discoveries = yield* transaction
    .select({ status: scanJobs.status })
    .from(scanJobs)
    .where(and(eq(scanJobs.runId, runId), eq(scanJobs.operation, "discover")));
  if (discoveries.some((job) => activeStatuses.includes(job.status))) return 0;
  const parked = and(
    eq(scanJobs.runId, runId),
    eq(scanJobs.operation, "cleanup"),
    eq(scanJobs.status, "queued"),
    eq(scanJobs.availableAtMs, cleanupParkedAtMs),
  );
  if (discoveries.every((job) => job.status === "succeeded")) {
    yield* transaction.update(scanJobs).set({ availableAtMs: nowMs }).where(parked);
    return 0;
  }
  const cancelled = yield* transaction
    .update(scanJobs)
    .set({ status: "cancelled", availableAtMs: nowMs, startedAtMs: nowMs, finishedAtMs: nowMs })
    .where(parked)
    .returning({ id: scanJobs.id });
  return cancelled.length;
});

// Failure outranks cancellation, which outranks success. A run without jobs did
// no work, so it is not reported as a success.
const finishRunIfDone = Effect.fn("ScanJobs.finishRunIfDone")(function* (
  transaction: DatabaseTransaction,
  runId: string,
  nowMs: number,
) {
  const tallies = yield* transaction
    .select({ status: scanJobs.status, jobs: count() })
    .from(scanJobs)
    .where(eq(scanJobs.runId, runId))
    .groupBy(scanJobs.status);
  const jobs = (status: string) => tallies.find((tally) => tally.status === status)?.jobs ?? 0;
  if (activeStatuses.some((status) => jobs(status) > 0)) return null;

  let outcome: {
    readonly status: FinishedRunStatus;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  };
  if (jobs("failed") > 0) {
    const failure = yield* transaction
      .select({ errorCode: scanJobs.errorCode, errorMessage: scanJobs.errorMessage })
      .from(scanJobs)
      .where(and(eq(scanJobs.runId, runId), eq(scanJobs.status, "failed")))
      .orderBy(asc(scanJobs.finishedAtMs), asc(scanJobs.id))
      .get();
    outcome = {
      status: "failed",
      errorCode: "JOB_FAILED",
      errorMessage: failure?.errorMessage ?? failure?.errorCode ?? null,
    };
  } else if (tallies.length === 0) {
    outcome = { status: "failed", errorCode: "NO_JOBS", errorMessage: "Scan run had no jobs" };
  } else {
    outcome = {
      status: jobs("cancelled") > 0 ? "cancelled" : "succeeded",
      errorCode: null,
      errorMessage: null,
    };
  }

  // The clock may sit behind the times already stored on the run; its timestamp
  // constraints must hold regardless or the run could never be finished.
  const finishedAtMs = sql<number>`max(${nowMs}, ${scanRuns.createdAtMs}, coalesce(${scanRuns.startedAtMs}, 0))`;
  const [finished] = yield* transaction
    .update(scanRuns)
    .set({
      ...outcome,
      startedAtMs: sql`coalesce(${scanRuns.startedAtMs}, ${finishedAtMs})`,
      finishedAtMs,
    })
    .where(and(eq(scanRuns.id, runId), inArray(scanRuns.status, activeStatuses)))
    .returning({ id: scanRuns.id });
  return finished === undefined ? null : { runId, status: outcome.status };
});

const settleRun = Effect.fn("ScanJobs.settleRun")(function* (
  transaction: DatabaseTransaction,
  runId: string,
  nowMs: number,
  discoveryEnded: boolean,
) {
  const cleanupsCancelled = discoveryEnded ? yield* settleCleanups(transaction, runId, nowMs) : 0;
  const run = yield* finishRunIfDone(transaction, runId, nowMs);
  return { cleanupsCancelled, run } satisfies ScanRunSettlement;
});

const heldBy = (job: { readonly id: string; readonly lockedBy: string | null }) =>
  and(
    eq(scanJobs.id, job.id),
    eq(scanJobs.status, "running"),
    eq(scanJobs.lockedBy, job.lockedBy ?? ""),
  );

const released = { lockedAtMs: null, lockedBy: null };
const requeuedAt = (availableAtMs: number) => ({
  ...released,
  status: "queued",
  availableAtMs,
  startedAtMs: null,
  finishedAtMs: null,
});
const endedAt = (nowMs: number) => ({
  ...released,
  finishedAtMs: sql<number>`max(${nowMs}, ${scanJobs.startedAtMs})`,
});

export const completeScanJob = Effect.fn("ScanJobs.complete")(function* (
  database: DatabaseClient,
  job: ClaimedScanJob,
  nowMs: number,
  followUp: ScanJobFollowUp,
) {
  return yield* database.transaction((transaction) =>
    Effect.gen(function* () {
      const [completed] = yield* transaction
        .update(scanJobs)
        .set({ ...endedAt(nowMs), status: "succeeded", errorCode: null, errorMessage: null })
        .where(heldBy(job))
        .returning({ id: scanJobs.id });
      if (completed === undefined) return notOwned;
      yield* insertJobs(transaction, job.runId, followUp.jobs, nowMs);
      for (const run of followUp.runs) yield* insertScanRun(transaction, run, nowMs);
      const settlement = yield* settleRun(
        transaction,
        job.runId,
        nowMs,
        job.operation === "discover",
      );
      return { owned: true, ...settlement } satisfies ScanJobSettlement;
    }),
  );
});

export const failScanJob = Effect.fn("ScanJobs.fail")(function* (
  database: DatabaseClient,
  job: ClaimedScanJob,
  nowMs: number,
  errorMessage: string,
) {
  const retry = job.attempts < job.maxAttempts;
  return yield* database.transaction((transaction) =>
    Effect.gen(function* () {
      const [failed] = yield* transaction
        .update(scanJobs)
        .set({
          ...(retry
            ? requeuedAt(nowMs + retryDelayMs(job.attempts))
            : { ...endedAt(nowMs), status: "failed" }),
          errorCode: "JOB_FAILED",
          errorMessage,
        })
        .where(heldBy(job))
        .returning({ id: scanJobs.id });
      if (failed === undefined) return notOwned;
      if (retry) return { owned: true, ...unsettled } satisfies ScanJobSettlement;
      const settlement = yield* settleRun(
        transaction,
        job.runId,
        nowMs,
        job.operation === "discover",
      );
      return { owned: true, ...settlement } satisfies ScanJobSettlement;
    }),
  );
});

export interface ScanRecovery {
  readonly requeued: number;
  readonly failed: number;
  readonly settlements: ReadonlyArray<ScanRunSettlement & { readonly runId: string }>;
}

/**
 * Takes jobs back from workers whose lease ran out: a job with attempts left is
 * requeued, an exhausted one fails and settles its run like any other failure.
 */
export const recoverScanJobs = Effect.fn("ScanJobs.recover")(function* (
  database: DatabaseClient,
  input: { readonly nowMs: number; readonly leaseMs: number; readonly limit: number },
) {
  const expired = yield* database
    .select({
      id: scanJobs.id,
      runId: scanJobs.runId,
      operation: scanJobs.operation,
      attempts: scanJobs.attempts,
      maxAttempts: scanJobs.maxAttempts,
      lockedBy: scanJobs.lockedBy,
      lockedAtMs: scanJobs.lockedAtMs,
    })
    .from(scanJobs)
    .where(
      and(
        eq(scanJobs.status, "running"),
        isNotNull(scanJobs.lockedAtMs),
        lt(scanJobs.lockedAtMs, input.nowMs - input.leaseMs),
      ),
    )
    .orderBy(asc(scanJobs.lockedAtMs), asc(scanJobs.id))
    .limit(input.limit);
  let requeued = 0;
  let failed = 0;
  const settlements: Array<ScanRunSettlement & { readonly runId: string }> = [];
  for (const job of expired) {
    const retry = job.attempts < job.maxAttempts;
    const settlement = yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        // The job may have been finished or claimed again since it was selected;
        // only the expired claim itself is taken back.
        const [recovered] = yield* transaction
          .update(scanJobs)
          .set({
            ...(retry ? requeuedAt(input.nowMs) : { ...endedAt(input.nowMs), status: "failed" }),
            errorCode: "LEASE_EXPIRED",
            errorMessage: `The worker stopped responding on attempt ${job.attempts} of ${job.maxAttempts}`,
          })
          .where(and(heldBy(job), eq(scanJobs.lockedAtMs, job.lockedAtMs ?? 0)))
          .returning({ id: scanJobs.id });
        if (recovered === undefined) return null;
        if (retry) return unsettled;
        return yield* settleRun(transaction, job.runId, input.nowMs, job.operation === "discover");
      }),
    );
    if (settlement === null) continue;
    if (retry) requeued += 1;
    else {
      failed += 1;
      settlements.push({ runId: job.runId, ...settlement });
    }
  }
  return { requeued, failed, settlements } satisfies ScanRecovery;
});

/**
 * Settles active runs that have no job left to run: parked cleanups whose
 * discoveries have ended are released or cancelled, and runs whose jobs have all
 * ended are finished. Each pass moves every run it visits forward, so a bounded
 * batch cannot be held up by the same runs twice.
 */
export const reconcileScanRuns = Effect.fn("ScanJobs.reconcileRuns")(function* (
  database: DatabaseClient,
  input: { readonly nowMs: number; readonly limit: number },
) {
  const stalled = yield* database
    .select({ id: scanRuns.id })
    .from(scanRuns)
    .where(
      and(
        inArray(scanRuns.status, activeStatuses),
        notExists(
          database
            .select({ value: scanJobs.id })
            .from(scanJobs)
            .where(
              and(
                eq(scanJobs.runId, scanRuns.id),
                or(
                  eq(scanJobs.status, "running"),
                  and(eq(scanJobs.status, "queued"), lt(scanJobs.availableAtMs, cleanupParkedAtMs)),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(scanRuns.createdAtMs), asc(scanRuns.id))
    .limit(input.limit);
  const settlements: Array<ScanRunSettlement & { readonly runId: string }> = [];
  for (const run of stalled) {
    const settlement = yield* database.transaction((transaction) =>
      settleRun(transaction, run.id, input.nowMs, true),
    );
    settlements.push({ runId: run.id, ...settlement });
  }
  return settlements;
});
