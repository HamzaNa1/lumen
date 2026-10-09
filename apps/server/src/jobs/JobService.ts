import { ServerLogger } from "../core/Logger";
import type { ScanJob } from "@lumen/contracts";
import { backgroundTask, logJobOutcome } from "./JobLogging";
import {
  catalogItems,
  catalogItemSources,
  Database,
  libraryProfiles,
  mediaSourceAvailability,
  mediaSources,
  providerRecords,
  Repositories,
  scanJobs,
} from "@lumen/database";
import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { ServerConfig } from "../config/Config";
import { Cause, Clock, Context, Effect, Exit, Layer, Option } from "effect";
import { newUuid } from "../core/Security";
import { MediaIngest } from "../media/MediaIngest";
import { TmdbProvider } from "../media/Tmdb";
import { cleanupJobKey, parseCleanupJobKey, Scanner } from "../services/Scanner";
import { MetadataSettings } from "../services/MetadataSettings";
import { LibraryWatcher } from "./LibraryWatcher";
import {
  cleanupParkedAtMs,
  completeScanJob,
  failScanJob,
  insertScanRun,
  noFollowUp,
  reconcileScanRuns,
  recoverScanJobs,
  type ScanJobFollowUp,
  type ScanJobSettlement,
  type ScanRunSettlement,
} from "./ScanJobs";
import {
  claimNextServerJob,
  completeServerJob,
  failServerJob,
  LIBRARY_WATCHER_JOB,
  recoverServerJobs,
} from "./ServerJobs";

// Lease recovery and run reconciliation read every active job and run, so they
// run on this cadence rather than on every pass of the worker's idle loop.
const recoveryIntervalMs = 5_000;
const recoveryBatchSize = 100;

// `nowMs` is the caller's clock when an attempt began. Advancing it by the
// elapsed clock time keeps claim latency and run time in the lease deadline
// and in the recorded completion, failure, and retry times.
const attemptClock = (nowMs: number) =>
  Effect.map(Clock.Clock, (clock) => {
    const startedAtNanos = clock.currentTimeNanosUnsafe();
    return () =>
      nowMs + Math.ceil(Number(clock.currentTimeNanosUnsafe() - startedAtNanos) / 1_000_000);
  });

export interface JobServiceShape {
  readonly recover: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly runOne: (nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly refresh: (itemId: string, nowMs: number) => Effect.Effect<string, unknown>;
  readonly queueMissingMetadata: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly start: (signal: AbortSignal) => Promise<void>;
}

export const makeJobService = (config?: ServerConfig) =>
  Effect.gen(function* () {
    const logger = (yield* ServerLogger).child({ component: "jobs" });
    const database = yield* Database;
    const repositories = yield* Repositories;
    const scanner = yield* Scanner;
    const ingest = yield* Effect.serviceOption(MediaIngest);
    const tmdb = yield* Effect.serviceOption(TmdbProvider);
    const settings = yield* MetadataSettings;
    const watcher = yield* LibraryWatcher;
    const leaseMs = config?.scanLeaseMs ?? 300_000;

    const refresh: JobServiceShape["refresh"] = Effect.fn("JobService.refresh")(
      function* (itemId, nowMs) {
        if ((yield* settings.tmdbKey()) === null) throw new Error("TMDb is not configured");
        const item = yield* database
          .select({ libraryId: catalogItems.libraryId })
          .from(catalogItems)
          .where(eq(catalogItems.id, itemId))
          .get();
        if (item == null) throw new Error("Item not found");
        const descendantIds = yield* repositories.catalog.descendantItemIds(itemId);
        const sources = yield* database
          .selectDistinct({ sourceId: catalogItemSources.sourceId })
          .from(catalogItemSources)
          .where(inArray(catalogItemSources.itemId, descendantIds));
        if (sources.length === 0) throw new Error("Item has no source");
        const runId = newUuid();
        yield* database.transaction((transaction) =>
          insertScanRun(
            transaction,
            {
              runId,
              libraryId: item.libraryId,
              mode: "refresh",
              jobs: sources.map((source) => ({
                sourceId: source.sourceId,
                dedupeKey: `metadata:refresh:${source.sourceId}:${runId}`,
                operation: "metadata",
                priority: 300,
                maxAttempts: 3,
              })),
            },
            nowMs,
          ),
        );
        return runId;
      },
    );

    const queueMissingMetadata = Effect.fn("JobService.queueMissingMetadata")(function* (
      nowMs: number,
    ) {
      if ((yield* settings.tmdbKey()) === null) return 0;
      const sources = yield* database
        .selectDistinct({
          sourceId: mediaSources.id,
          libraryId: mediaSources.libraryId,
        })
        .from(mediaSources)
        .innerJoin(libraryProfiles, eq(libraryProfiles.libraryId, mediaSources.libraryId))
        .innerJoin(catalogItemSources, eq(catalogItemSources.sourceId, mediaSources.id))
        .innerJoin(catalogItems, eq(catalogItems.id, catalogItemSources.itemId))
        .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, mediaSources.id))
        .where(
          and(
            inArray(libraryProfiles.kind, ["movies", "shows"]),
            inArray(catalogItems.kind, ["movie", "episode"]),
            sql`coalesce(${mediaSourceAvailability.isAvailable}, 1) = 1`,
            notExists(
              database
                .select({ value: providerRecords.id })
                .from(providerRecords)
                .where(
                  and(
                    eq(providerRecords.itemId, catalogItems.id),
                    eq(providerRecords.provider, "tmdb"),
                  ),
                ),
            ),
            notExists(
              database
                .select({ value: scanJobs.id })
                .from(scanJobs)
                .where(
                  and(
                    eq(scanJobs.sourceId, mediaSources.id),
                    eq(scanJobs.operation, "metadata"),
                    inArray(scanJobs.status, ["queued", "running"]),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(mediaSources.libraryId), asc(mediaSources.id));
      const sourcesByLibrary = new Map<string, Array<string>>();
      for (const source of sources) {
        const sourceIds = sourcesByLibrary.get(source.libraryId) ?? [];
        sourceIds.push(source.sourceId);
        sourcesByLibrary.set(source.libraryId, sourceIds);
      }
      for (const [libraryId, sourceIds] of sourcesByLibrary) {
        yield* database.transaction((transaction) =>
          insertScanRun(
            transaction,
            {
              runId: newUuid(),
              libraryId,
              mode: "refresh",
              jobs: sourceIds.map((sourceId) => ({
                sourceId,
                dedupeKey: `metadata:startup:${sourceId}`,
                operation: "metadata",
                priority: 50,
                maxAttempts: 3,
              })),
            },
            nowMs,
          ),
        );
      }
      return sources.length;
    });

    const logSettlement = (runId: string, settlement: ScanRunSettlement) => {
      if (settlement.cleanupsCancelled > 0)
        logger.warn("scan_cleanup_skipped", { runId, reason: "discovery_failed" });
      if (settlement.run !== null)
        logger[settlement.run.status === "failed" ? "error" : "info"]("scan_run_finished", {
          runId,
          result: settlement.run.status,
        });
    };

    const recover: JobServiceShape["recover"] = Effect.fn("JobService.recover")(function* (nowMs) {
      const scans = yield* recoverScanJobs(database, { nowMs, leaseMs, limit: recoveryBatchSize });
      const recovered = scans.requeued + scans.failed + (yield* recoverServerJobs(database, nowMs));
      if (recovered > 0) logger.warn("job_leases_recovered", { count: recovered });
      const reconciled = yield* reconcileScanRuns(database, { nowMs, limit: recoveryBatchSize });
      for (const { runId, ...settlement } of [...scans.settlements, ...reconciled])
        logSettlement(runId, settlement);
      const repaired = reconciled.filter((settlement) => settlement.run !== null).length;
      if (repaired > 0) logger.warn("scan_runs_reconciled", { count: repaired });
      return recovered;
    });

    // Time left at the end of a lease to stop the job and record the outcome.
    const leaseStopMarginMs = Math.min(5_000, Math.floor(leaseMs / 10));

    const runServerJob = Effect.fn("JobService.runServerJob")(function* (nowMs: number) {
      const currentMs = yield* attemptClock(nowMs);
      const startedAt = performance.now();
      const job = yield* claimNextServerJob(database, {
        workerId: `server-${newUuid()}`,
        nowMs,
        leaseMs,
      });
      if (job === null) return false;
      const fields = {
        jobId: job.id,
        operation: job.kind,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      };
      logger.debug("job_started", fields);
      // Stop the job before its persisted lease expires so recovery never hands the
      // same job to a second worker while this one is still running it.
      const budgetMs = job.leaseExpiresAtMs - leaseStopMarginMs - currentMs();
      const leaseExceeded = Effect.fail(new Error(`Job exceeded its ${leaseMs}ms lease`));
      const work =
        job.kind === LIBRARY_WATCHER_JOB
          ? watcher.check(nowMs)
          : Effect.fail(new Error(`Unknown job kind: ${job.kind}`));
      const outcome = yield* Effect.exit(
        budgetMs > 0
          ? work.pipe(Effect.timeoutOrElse({ duration: budgetMs, orElse: () => leaseExceeded }))
          : leaseExceeded,
      );
      if (Exit.isSuccess(outcome)) yield* completeServerJob(database, job, currentMs());
      else {
        const error = Cause.squash(outcome.cause);
        yield* failServerJob(
          database,
          job,
          currentMs(),
          error instanceof Error ? error.message : String(error),
        );
      }
      logJobOutcome(logger, fields, outcome, startedAt);
      return true;
    });

    const runScanJob = Effect.fn("JobService.runScanJob")(function* (job: ScanJob) {
      if (job.operation === "discover") {
        const rootId = job.dedupeKey.slice("discover:".length);
        const discovery = yield* scanner.discover(job.runId, rootId);
        if (!discovery.complete || discovery.generation === null) {
          logger.warn("scan_cleanup_skipped", {
            runId: job.runId,
            rootId,
            reason: "discovery_incomplete",
          });
          return noFollowUp;
        }
        return {
          ...noFollowUp,
          jobs: [
            {
              parentJobId: job.id,
              sourceId: null,
              dedupeKey: cleanupJobKey(rootId, discovery.generation),
              operation: "cleanup",
              priority: 200,
              maxAttempts: 3,
              availableAtMs: cleanupParkedAtMs,
            },
          ],
        } satisfies ScanJobFollowUp;
      }
      if (job.operation === "probe") {
        if (job.sourceId === null) throw new Error("Job has no source");
        if (Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
        if ((yield* settings.tmdbKey()) === null || Option.isNone(tmdb)) return noFollowUp;
        const source = yield* database
          .select({ libraryId: mediaSources.libraryId })
          .from(mediaSources)
          .innerJoin(libraryProfiles, eq(libraryProfiles.libraryId, mediaSources.libraryId))
          .where(
            and(
              eq(mediaSources.id, job.sourceId),
              inArray(libraryProfiles.kind, ["movies", "shows"]),
            ),
          )
          .get();
        if (source == null) return noFollowUp;
        return {
          ...noFollowUp,
          runs: [
            {
              runId: newUuid(),
              libraryId: source.libraryId,
              mode: "refresh",
              jobs: [
                {
                  sourceId: job.sourceId,
                  dedupeKey: `metadata:${job.sourceId}`,
                  operation: "metadata",
                  priority: 100,
                  maxAttempts: 3,
                },
              ],
            },
          ],
        } satisfies ScanJobFollowUp;
      }
      if (job.operation === "metadata") {
        if (job.sourceId === null) throw new Error("Job has no source");
        if (Option.isSome(tmdb)) yield* tmdb.value.enrichSource(job.sourceId);
      } else if (job.operation === "cleanup") {
        const { rootId, generation } = parseCleanupJobKey(job.dedupeKey);
        yield* scanner.cleanup(job.runId, rootId, generation);
      } else if (job.operation === "artwork" || job.operation === "analyze") {
        if (job.sourceId !== null && Option.isSome(ingest))
          yield* ingest.value.ingest(job.sourceId);
      }
      return noFollowUp;
    });

    const runOne: JobServiceShape["runOne"] = Effect.fn("JobService.runOne")(function* (nowMs) {
      if (yield* runServerJob(nowMs)) return true;
      const currentMs = yield* attemptClock(nowMs);
      const job = yield* repositories.scanning.claimNextJob({
        workerId: `server-${newUuid()}`,
        nowMs,
        operations: [],
      });
      if (job === null) return false;
      const startedAt = performance.now();
      const fields = {
        jobId: job.id,
        runId: job.runId,
        sourceId: job.sourceId,
        operation: job.operation,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      };
      logger.debug("job_started", fields);
      const outcome = yield* Effect.exit(runScanJob(job));
      let settlement: ScanJobSettlement;
      if (Exit.isSuccess(outcome))
        settlement = yield* completeScanJob(database, job, currentMs(), outcome.value);
      else {
        const cause = Cause.squash(outcome.cause);
        settlement = yield* failScanJob(
          database,
          job,
          currentMs(),
          cause instanceof Error ? cause.message : "Job failed",
        );
      }
      // Recovery handed the job to another worker, whose outcome is the one recorded.
      if (!settlement.owned) logger.warn("job_lease_lost", fields);
      logJobOutcome(logger, fields, outcome, startedAt);
      logSettlement(job.runId, settlement);
      return true;
    });

    const start = async (signal: AbortSignal): Promise<void> => {
      logger.info("job_worker_started");
      const queued = await backgroundTask(
        logger,
        "metadata_backfill",
        () => queueMissingMetadata(Date.now()),
        0,
      )();
      if (queued > 0) logger.info("metadata_backfill_queued", { count: queued });
      const recoverJobs = backgroundTask(logger, "job_recovery", () => recover(Date.now()), 0);
      const runJob = backgroundTask(logger, "job_dispatch", () => runOne(Date.now()), false);
      let recoveryDueAt = 0;
      try {
        while (!signal.aborted) {
          if (performance.now() >= recoveryDueAt) {
            await recoverJobs();
            recoveryDueAt = performance.now() + recoveryIntervalMs;
          }
          const didWork = await runJob();
          if (!didWork && !signal.aborted) await Bun.sleep(100);
        }
      } finally {
        logger.info("job_worker_stopped");
      }
    };

    return { recover, runOne, refresh, queueMissingMetadata, start };
  });

export class JobService extends Context.Service<JobService, JobServiceShape>()(
  "@lumen/server/Jobs",
) {}
export const JobServiceLive = Layer.effect(JobService, makeJobService());
export const JobServiceLiveWithConfig = (config: ServerConfig) =>
  Layer.effect(JobService, makeJobService(config));
