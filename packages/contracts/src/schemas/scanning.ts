import { Schema } from "effect";
import { NonEmptyText, UtcMillis, Uuid } from "./common.ts";

export const ScanRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const ScanJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const OutboxStatus = Schema.Literals(["pending", "processing", "published", "failed"]);

export const ScanRun = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  mode: Schema.Literals(["full", "incremental", "refresh"]),
  status: ScanRunStatus,
  startedAtMs: Schema.NullOr(UtcMillis),
  finishedAtMs: Schema.NullOr(UtcMillis),
  errorCode: Schema.NullOr(NonEmptyText),
  errorMessage: Schema.NullOr(Schema.String),
  createdAtMs: UtcMillis,
});
export type ScanRun = Schema.Schema.Type<typeof ScanRun>;

const FileCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Per-run discovery counts, separating files seen on disk from files actually probed. */
export const ScanRunStats = Schema.Struct({
  discovered: FileCount,
  new: FileCount,
  changed: FileCount,
  moved: FileCount,
  unchanged: FileCount,
  skipped: FileCount,
  missing: FileCount,
  probesEnqueued: FileCount,
});
export type ScanRunStats = Schema.Schema.Type<typeof ScanRunStats>;

export const ScanJob = Schema.Struct({
  id: Uuid,
  runId: Uuid,
  parentJobId: Schema.NullOr(Uuid),
  sourceId: Schema.NullOr(Uuid),
  dedupeKey: NonEmptyText,
  operation: Schema.Literals(["discover", "probe", "artwork", "metadata", "analyze", "cleanup"]),
  status: ScanJobStatus,
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  availableAtMs: UtcMillis,
  lockedAtMs: Schema.NullOr(UtcMillis),
  lockedBy: Schema.NullOr(NonEmptyText),
  startedAtMs: Schema.NullOr(UtcMillis),
  finishedAtMs: Schema.NullOr(UtcMillis),
  errorCode: Schema.NullOr(NonEmptyText),
  errorMessage: Schema.NullOr(Schema.String),
});
export type ScanJob = Schema.Schema.Type<typeof ScanJob>;

export const JobLogEntry = Schema.Struct({
  id: Uuid,
  runId: Uuid,
  libraryId: Uuid,
  libraryName: NonEmptyText,
  mode: Schema.Literals(["full", "incremental", "refresh"]),
  operation: Schema.Literals(["discover", "probe", "artwork", "metadata", "analyze", "cleanup"]),
  status: ScanJobStatus,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  availableAtMs: UtcMillis,
  startedAtMs: Schema.NullOr(UtcMillis),
  finishedAtMs: Schema.NullOr(UtcMillis),
  errorCode: Schema.NullOr(NonEmptyText),
  errorMessage: Schema.NullOr(Schema.String),
});
export type JobLogEntry = Schema.Schema.Type<typeof JobLogEntry>;

export const OutboxEvent = Schema.Struct({
  id: Uuid,
  aggregateType: NonEmptyText,
  aggregateId: Uuid,
  eventType: NonEmptyText,
  payloadJson: Schema.String,
  status: OutboxStatus,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  availableAtMs: UtcMillis,
  lockedAtMs: Schema.NullOr(UtcMillis),
  publishedAtMs: Schema.NullOr(UtcMillis),
  lastError: Schema.NullOr(Schema.String),
  createdAtMs: UtcMillis,
});
export type OutboxEvent = Schema.Schema.Type<typeof OutboxEvent>;

export const CreateScanJob = Schema.Struct({
  id: Uuid,
  runId: Uuid,
  parentJobId: Schema.NullOr(Uuid),
  sourceId: Schema.NullOr(Uuid),
  dedupeKey: NonEmptyText,
  operation: Schema.Literals(["discover", "probe", "artwork", "metadata", "analyze", "cleanup"]),
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  availableAtMs: UtcMillis,
});
export type CreateScanJob = Schema.Schema.Type<typeof CreateScanJob>;

export const CreateOutboxEvent = Schema.Struct({
  id: Uuid,
  aggregateType: NonEmptyText,
  aggregateId: Uuid,
  eventType: NonEmptyText,
  payloadJson: Schema.String,
  availableAtMs: UtcMillis,
});
export type CreateOutboxEvent = Schema.Schema.Type<typeof CreateOutboxEvent>;

export const FinishScanRun = Schema.Struct({
  runId: Uuid,
  status: Schema.Literals(["succeeded", "failed", "cancelled"]),
  nowMs: UtcMillis,
  errorCode: Schema.NullOr(NonEmptyText),
  errorMessage: Schema.NullOr(Schema.String),
});
export type FinishScanRun = Schema.Schema.Type<typeof FinishScanRun>;
