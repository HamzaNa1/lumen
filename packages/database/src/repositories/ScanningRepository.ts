import {
  CreateOutboxEvent,
  CreateScanJob,
  FinishScanRun,
  OutboxEvent,
  ScanJob,
  ScanRun,
  StartScan,
  Uuid,
} from "@lumen/contracts";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import { outboxEvents, scanJobs, scanRuns } from "../tables/schema";
import { boundary, guard } from "./Boundary";

const runSelection = {
  id: scanRuns.id,
  libraryId: scanRuns.libraryId,
  mode: scanRuns.mode,
  status: scanRuns.status,
  startedAtMs: scanRuns.startedAtMs,
  finishedAtMs: scanRuns.finishedAtMs,
  errorCode: scanRuns.errorCode,
  errorMessage: scanRuns.errorMessage,
  createdAtMs: scanRuns.createdAtMs,
};

const jobSelection = {
  id: scanJobs.id,
  runId: scanJobs.runId,
  parentJobId: scanJobs.parentJobId,
  sourceId: scanJobs.sourceId,
  dedupeKey: scanJobs.dedupeKey,
  operation: scanJobs.operation,
  status: scanJobs.status,
  priority: scanJobs.priority,
  attempts: scanJobs.attempts,
  maxAttempts: scanJobs.maxAttempts,
  availableAtMs: scanJobs.availableAtMs,
  lockedAtMs: scanJobs.lockedAtMs,
  lockedBy: scanJobs.lockedBy,
  startedAtMs: scanJobs.startedAtMs,
  finishedAtMs: scanJobs.finishedAtMs,
  errorCode: scanJobs.errorCode,
  errorMessage: scanJobs.errorMessage,
};

const outboxSelection = {
  id: outboxEvents.id,
  aggregateType: outboxEvents.aggregateType,
  aggregateId: outboxEvents.aggregateId,
  eventType: outboxEvents.eventType,
  payloadJson: outboxEvents.payloadJson,
  status: outboxEvents.status,
  attempts: outboxEvents.attempts,
  availableAtMs: outboxEvents.availableAtMs,
  lockedAtMs: outboxEvents.lockedAtMs,
  publishedAtMs: outboxEvents.publishedAtMs,
  lastError: outboxEvents.lastError,
  createdAtMs: outboxEvents.createdAtMs,
};

const EntityId = Schema.Struct({ id: Uuid });
const RunId = Schema.Struct({ runId: Uuid });
const ClaimJob = Schema.Struct({
  workerId: Schema.String.check(Schema.isMinLength(1)),
  nowMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operations: Schema.Array(Schema.String),
});
const ClaimOutbox = Schema.Struct({
  workerId: Schema.String.check(Schema.isMinLength(1)),
  nowMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const makeScanningRepository = (database: DatabaseClient) => {
  const startRun = Effect.fn("ScanningRepository.startRun")(function* (input: unknown) {
    const value = yield* boundary(StartScan, input, "scanning.startRun");
    const resultRows = yield* guard(
      database
        .insert(scanRuns)
        .values({
          id: value.runId,
          libraryId: value.libraryId,
          mode: value.mode,
          status: "running",
          startedAtMs: value.startedAtMs,
          createdAtMs: value.startedAtMs,
        })
        .returning(runSelection),
      "scanning.startRun",
    );
    const [row] = resultRows;
    return yield* boundary(ScanRun, row, "scanning.startRun.result");
  });

  const finishRun = Effect.fn("ScanningRepository.finishRun")(function* (input: unknown) {
    const value = yield* boundary(FinishScanRun, input, "scanning.finishRun");
    const resultRows = yield* guard(
      database
        .update(scanRuns)
        .set({
          status: value.status,
          finishedAtMs: value.nowMs,
          errorCode: value.errorCode,
          errorMessage: value.errorMessage,
        })
        .where(eq(scanRuns.id, value.runId))
        .returning(runSelection),
      "scanning.finishRun",
    );
    const [row] = resultRows;
    return yield* boundary(ScanRun, row, "scanning.finishRun.result");
  });

  const getRun = Effect.fn("ScanningRepository.getRun")(function* (input: unknown) {
    const value = yield* boundary(EntityId, input, "scanning.getRun");
    const row = yield* guard(
      database.select(runSelection).from(scanRuns).where(eq(scanRuns.id, value.id)).get(),
      "scanning.getRun",
    );
    return yield* boundary(ScanRun, row, "scanning.getRun.result");
  });

  const createJob = Effect.fn("ScanningRepository.createJob")(function* (input: unknown) {
    const value = yield* boundary(CreateScanJob, input, "scanning.createJob");
    const resultRows = yield* guard(
      database
        .insert(scanJobs)
        .values({
          id: value.id,
          runId: value.runId,
          parentJobId: value.parentJobId,
          sourceId: value.sourceId,
          dedupeKey: value.dedupeKey,
          operation: value.operation,
          priority: value.priority,
          maxAttempts: value.maxAttempts,
          availableAtMs: value.availableAtMs,
        })
        .returning(jobSelection),
      "scanning.createJob",
    );
    const [row] = resultRows;
    return yield* boundary(ScanJob, row, "scanning.createJob.result");
  });

  const getJob = Effect.fn("ScanningRepository.getJob")(function* (input: unknown) {
    const value = yield* boundary(EntityId, input, "scanning.getJob");
    const row = yield* guard(
      database.select(jobSelection).from(scanJobs).where(eq(scanJobs.id, value.id)).get(),
      "scanning.getJob",
    );
    return yield* boundary(ScanJob, row, "scanning.getJob.result");
  });

  const listJobs = Effect.fn("ScanningRepository.listJobs")(function* (input: unknown) {
    const value = yield* boundary(RunId, input, "scanning.listJobs");
    const rows = yield* guard(
      database
        .select(jobSelection)
        .from(scanJobs)
        .where(eq(scanJobs.runId, value.runId))
        .orderBy(asc(scanJobs.availableAtMs), asc(scanJobs.id)),
      "scanning.listJobs",
    );
    return yield* boundary(Schema.Array(ScanJob), rows, "scanning.listJobs.result");
  });

  const claimNextJob = Effect.fn("ScanningRepository.claimNextJob")(function* (input: unknown) {
    const value = yield* boundary(ClaimJob, input, "scanning.claimNextJob");
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const candidates = yield* transaction
            .select({ id: scanJobs.id })
            .from(scanJobs)
            .where(
              and(
                eq(scanJobs.status, "queued"),
                lte(scanJobs.availableAtMs, value.nowMs),
                value.operations.length === 0
                  ? sql`1 = 1`
                  : inArray(scanJobs.operation, value.operations),
              ),
            )
            .orderBy(desc(scanJobs.priority), asc(scanJobs.availableAtMs), asc(scanJobs.id))
            .limit(1);
          const candidate = candidates[0];
          if (candidate === undefined) return null;
          const [claimed] = yield* transaction
            .update(scanJobs)
            .set({
              status: "running",
              attempts: sql`${scanJobs.attempts} + 1`,
              lockedAtMs: value.nowMs,
              lockedBy: value.workerId,
              startedAtMs: value.nowMs,
            })
            .where(and(eq(scanJobs.id, candidate.id), eq(scanJobs.status, "queued")))
            .returning(jobSelection);
          return claimed ?? null;
        }),
      ),
      "scanning.claimNextJob",
    );
    return yield* boundary(Schema.NullOr(ScanJob), row, "scanning.claimNextJob.result");
  });

  const enqueueOutbox = Effect.fn("ScanningRepository.enqueueOutbox")(function* (input: unknown) {
    const value = yield* boundary(CreateOutboxEvent, input, "scanning.enqueueOutbox");
    const resultRows = yield* guard(
      database
        .insert(outboxEvents)
        .values({
          id: value.id,
          aggregateType: value.aggregateType,
          aggregateId: value.aggregateId,
          eventType: value.eventType,
          payloadJson: value.payloadJson,
          availableAtMs: value.availableAtMs,
          createdAtMs: value.availableAtMs,
        })
        .returning(outboxSelection),
      "scanning.enqueueOutbox",
    );
    const [row] = resultRows;
    return yield* boundary(OutboxEvent, row, "scanning.enqueueOutbox.result");
  });

  const claimNextOutbox = Effect.fn("ScanningRepository.claimNextOutbox")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(ClaimOutbox, input, "scanning.claimNextOutbox");
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const candidates = yield* transaction
            .select({ id: outboxEvents.id })
            .from(outboxEvents)
            .where(
              and(
                inArray(outboxEvents.status, ["pending", "failed"]),
                lte(outboxEvents.availableAtMs, value.nowMs),
              ),
            )
            .orderBy(asc(outboxEvents.availableAtMs), asc(outboxEvents.createdAtMs))
            .limit(1);
          const candidate = candidates[0];
          if (candidate === undefined) return undefined;
          const [claimed] = yield* transaction
            .update(outboxEvents)
            .set({
              status: "processing",
              attempts: sql`${outboxEvents.attempts} + 1`,
              lockedAtMs: value.nowMs,
            })
            .where(
              and(
                eq(outboxEvents.id, candidate.id),
                inArray(outboxEvents.status, ["pending", "failed"]),
              ),
            )
            .returning(outboxSelection);
          return claimed;
        }),
      ),
      "scanning.claimNextOutbox",
    );
    return yield* boundary(Schema.NullOr(OutboxEvent), row, "scanning.claimNextOutbox.result");
  });

  return {
    startRun,
    finishRun,
    getRun,
    createJob,
    getJob,
    listJobs,
    claimNextJob,
    enqueueOutbox,
    claimNextOutbox,
  };
};

export type ScanningRepository = ReturnType<typeof makeScanningRepository>;
