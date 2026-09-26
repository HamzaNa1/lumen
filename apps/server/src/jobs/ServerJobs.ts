import { type DatabaseClient, jobs } from "@lumen/database";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { newUuid } from "../core/Security";

// Durable, library-independent background work stored in the `jobs` table.
// Scan work lives in `scan_jobs` because it belongs to a library scan run.
export const LIBRARY_WATCHER_JOB = "library-watcher";

const FINISHED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const retryDelayMs = (attempts: number): number =>
  Math.min(60_000, 2 ** Math.min(10, attempts) * 1_000);

export const enqueueServerJob = Effect.fn("ServerJobs.enqueue")(function* (
  database: DatabaseClient,
  input: { readonly kind: string; readonly nowMs: number; readonly maxAttempts: number },
) {
  yield* database
    .delete(jobs)
    .where(
      and(
        eq(jobs.kind, input.kind),
        inArray(jobs.state, ["succeeded", "failed", "cancelled"]),
        lt(jobs.completedAtMs, input.nowMs - FINISHED_JOB_RETENTION_MS),
      ),
    );
  // Singleton kinds carry a partial unique index over active rows, so a job that
  // is still pending or running absorbs the enqueue instead of building a backlog.
  const inserted = yield* database
    .insert(jobs)
    .values({
      id: newUuid(),
      kind: input.kind,
      payloadJson: "{}",
      state: "pending",
      idempotencyKey: `${input.kind}:${input.nowMs}`,
      maxAttempts: input.maxAttempts,
      nextRunAtMs: input.nowMs,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return inserted.length > 0;
});

export interface ClaimedServerJob {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAtMs: number;
}

export const claimNextServerJob = Effect.fn("ServerJobs.claimNext")(function* (
  database: DatabaseClient,
  input: { readonly workerId: string; readonly nowMs: number; readonly leaseMs: number },
) {
  return yield* database.transaction((transaction) =>
    Effect.gen(function* () {
      const [candidate] = yield* transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.state, "pending"), lte(jobs.nextRunAtMs, input.nowMs)))
        .orderBy(asc(jobs.nextRunAtMs), asc(jobs.id))
        .limit(1);
      if (candidate === undefined) return null;
      const [claimed] = yield* transaction
        .update(jobs)
        .set({
          state: "running",
          attempts: sql`${jobs.attempts} + 1`,
          leaseOwner: input.workerId,
          leaseExpiresAtMs: input.nowMs + input.leaseMs,
          updatedAtMs: input.nowMs,
        })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.state, "pending")))
        .returning({
          id: jobs.id,
          kind: jobs.kind,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
          leaseOwner: jobs.leaseOwner,
          leaseExpiresAtMs: jobs.leaseExpiresAtMs,
        });
      return (claimed ?? null) as ClaimedServerJob | null;
    }),
  );
});

const ownedBy = (job: ClaimedServerJob) =>
  and(eq(jobs.id, job.id), eq(jobs.state, "running"), eq(jobs.leaseOwner, job.leaseOwner));

export const completeServerJob = Effect.fn("ServerJobs.complete")(function* (
  database: DatabaseClient,
  job: ClaimedServerJob,
  nowMs: number,
) {
  yield* database
    .update(jobs)
    .set({
      state: "succeeded",
      completedAtMs: nowMs,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      updatedAtMs: nowMs,
    })
    .where(ownedBy(job));
});

export const failServerJob = Effect.fn("ServerJobs.fail")(function* (
  database: DatabaseClient,
  job: ClaimedServerJob,
  nowMs: number,
  errorMessage: string,
) {
  const retry = job.attempts < job.maxAttempts;
  const delay = retryDelayMs(job.attempts);
  yield* database
    .update(jobs)
    .set({
      state: retry ? "pending" : "failed",
      nextRunAtMs: retry ? nowMs + delay : nowMs,
      completedAtMs: retry ? null : nowMs,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      lastErrorCode: "JOB_FAILED",
      lastErrorMessage: errorMessage,
      updatedAtMs: nowMs,
    })
    .where(ownedBy(job));
});

export const recoverServerJobs = Effect.fn("ServerJobs.recover")(function* (
  database: DatabaseClient,
  nowMs: number,
) {
  const exhausted = sql`${jobs.attempts} >= ${jobs.maxAttempts}`;
  const recovered = yield* database
    .update(jobs)
    .set({
      state: sql`case when ${exhausted} then 'failed' else 'pending' end`,
      nextRunAtMs: nowMs,
      completedAtMs: sql`case when ${exhausted} then ${nowMs} else null end`,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      lastErrorCode: "LEASE_EXPIRED",
      updatedAtMs: nowMs,
    })
    .where(and(eq(jobs.state, "running"), lt(jobs.leaseExpiresAtMs, nowMs)))
    .returning({ id: jobs.id });
  return recovered.length;
});
