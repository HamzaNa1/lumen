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
  scanRuns,
} from "@lumen/database";
import { and, asc, count, eq, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import type { ServerConfig } from "../config/Config";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { newUuid } from "../core/Security";
import { MediaIngest } from "../media/MediaIngest";
import { TmdbProvider } from "../media/Tmdb";
import { cleanupJobKey, parseCleanupJobKey, Scanner } from "../services/Scanner";
import { MetadataSettings } from "../services/MetadataSettings";
import { LibraryWatcher } from "./LibraryWatcher";
import {
  claimNextServerJob,
  completeServerJob,
  failServerJob,
  LIBRARY_WATCHER_JOB,
  recoverServerJobs,
  retryDelayMs,
} from "./ServerJobs";

// Cleanup jobs wait at this availability until settleCleanups releases them.
const cleanupParkedAtMs = Number.MAX_SAFE_INTEGER;

export interface JobServiceShape {
  readonly recover: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly runOne: (nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly refresh: (itemId: string, nowMs: number) => Effect.Effect<string, unknown>;
  readonly queueMissingMetadata: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly start: (signal: AbortSignal) => Promise<void>;
}

export const makeJobService = (config?: ServerConfig) =>
  Effect.gen(function* () {
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
          Effect.gen(function* () {
            yield* transaction.insert(scanRuns).values({
              id: runId,
              libraryId: item.libraryId,
              mode: "refresh",
              status: "running",
              startedAtMs: nowMs,
              createdAtMs: nowMs,
            });
            for (const source of sources)
              yield* transaction.insert(scanJobs).values({
                id: newUuid(),
                runId,
                sourceId: source.sourceId,
                dedupeKey: `metadata:refresh:${source.sourceId}:${runId}`,
                operation: "metadata",
                priority: 300,
                maxAttempts: 3,
                availableAtMs: nowMs,
              });
          }),
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
      const runs = new Map<string, string>();
      for (const source of sources) {
        let runId = runs.get(source.libraryId);
        if (runId === undefined) {
          const run = yield* repositories.scanning.startRun({
            runId: newUuid(),
            libraryId: source.libraryId,
            mode: "refresh",
            startedAtMs: nowMs,
          });
          runId = run.id;
          runs.set(source.libraryId, runId);
        }
        yield* repositories.scanning.createJob({
          id: newUuid(),
          runId,
          parentJobId: null,
          sourceId: source.sourceId,
          dedupeKey: `metadata:startup:${source.sourceId}`,
          operation: "metadata",
          priority: 50,
          maxAttempts: 3,
          availableAtMs: nowMs,
        });
      }
      return sources.length;
    });

    // A source moved between roots is only matched once the destination root is
    // discovered, so cleanups stay parked until every discovery in the run ends.
    // If any discovery failed, a moved source may be unmatched: delete nothing.
    const settleCleanups = Effect.fn("JobService.settleCleanups")(function* (
      runId: string,
      nowMs: number,
    ) {
      const discoveries = yield* database
        .select({ status: scanJobs.status })
        .from(scanJobs)
        .where(and(eq(scanJobs.runId, runId), eq(scanJobs.operation, "discover")));
      if (discoveries.some((job) => job.status === "queued" || job.status === "running")) return;
      const failed = discoveries.some((job) => job.status !== "succeeded");
      const parked = and(
        eq(scanJobs.runId, runId),
        eq(scanJobs.operation, "cleanup"),
        eq(scanJobs.status, "queued"),
        eq(scanJobs.availableAtMs, cleanupParkedAtMs),
      );
      if (failed) {
        const cancelled = yield* database
          .update(scanJobs)
          .set({
            status: "cancelled",
            availableAtMs: nowMs,
            startedAtMs: nowMs,
            finishedAtMs: nowMs,
          })
          .where(parked)
          .returning({ id: scanJobs.id });
        if (cancelled.length > 0)
          console.warn("scan_cleanup_skipped", { runId, reason: "discovery_failed" });
      } else {
        yield* database.update(scanJobs).set({ availableAtMs: nowMs }).where(parked);
      }
    });

    const recover: JobServiceShape["recover"] = Effect.fn("JobService.recover")(function* (nowMs) {
      const rows = yield* database
        .select({ id: scanJobs.id, runId: scanJobs.runId, operation: scanJobs.operation })
        .from(scanJobs)
        .where(
          and(
            eq(scanJobs.status, "running"),
            isNotNull(scanJobs.lockedAtMs),
            lt(scanJobs.lockedAtMs, nowMs - leaseMs),
          ),
        );
      for (const row of rows) {
        yield* database
          .update(scanJobs)
          .set({
            status: sql`case when ${scanJobs.attempts} < ${scanJobs.maxAttempts} then 'queued' else 'failed' end`,
            lockedAtMs: null,
            lockedBy: null,
            startedAtMs: null,
            finishedAtMs: null,
            availableAtMs: nowMs,
            errorCode: "LEASE_EXPIRED",
          })
          .where(and(eq(scanJobs.id, row.id), eq(scanJobs.status, "running")));
        if (row.operation === "discover") yield* settleCleanups(row.runId, nowMs);
      }
      return rows.length + (yield* recoverServerJobs(database, nowMs));
    });

    // Time left at the end of a lease to stop the job and record the outcome.
    const leaseStopMarginMs = Math.min(5_000, Math.floor(leaseMs / 10));

    const runServerJob = Effect.fn("JobService.runServerJob")(function* (nowMs: number) {
      // `nowMs` is the caller's clock when this attempt began. Advancing it by the
      // real time elapsed keeps claim latency and run time in the lease deadline
      // and in the recorded completion, failure, and retry times.
      const startedAt = performance.now();
      const currentMs = () => nowMs + Math.ceil(performance.now() - startedAt);
      const job = yield* claimNextServerJob(database, {
        workerId: `server-${newUuid()}`,
        nowMs,
        leaseMs,
      });
      if (job === null) return false;
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
      return true;
    });

    const finishRunIfDone = Effect.fn("JobService.finishRunIfDone")(function* (
      runId: string,
      nowMs: number,
    ) {
      const remaining = yield* database
        .select({ count: count() })
        .from(scanJobs)
        .where(and(eq(scanJobs.runId, runId), inArray(scanJobs.status, ["queued", "running"])))
        .get();
      if ((remaining?.count ?? 0) === 0) {
        const failure = yield* database
          .select({ errorMessage: scanJobs.errorMessage })
          .from(scanJobs)
          .where(and(eq(scanJobs.runId, runId), eq(scanJobs.status, "failed")))
          .get();
        yield* repositories.scanning.finishRun({
          runId: runId,
          status: failure === undefined ? "succeeded" : "failed",
          nowMs,
          errorCode: failure === undefined ? null : "JOB_FAILED",
          errorMessage: failure?.errorMessage ?? null,
        });
      }
    });

    const runOne: JobServiceShape["runOne"] = Effect.fn("JobService.runOne")(function* (nowMs) {
      if (yield* runServerJob(nowMs)) return true;
      const job = yield* repositories.scanning.claimNextJob({
        workerId: `server-${newUuid()}`,
        nowMs,
        operations: [],
      });
      if (job === null) return false;
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          if (job.operation === "discover") {
            const rootId = job.dedupeKey.slice("discover:".length);
            const discovery = yield* scanner.discover(job.runId, rootId);
            if (!discovery.complete || discovery.generation === null) {
              console.warn("scan_cleanup_skipped", {
                runId: job.runId,
                rootId,
                reason: "discovery_incomplete",
              });
              return;
            }
            yield* repositories.scanning
              .createJob({
                id: newUuid(),
                runId: job.runId,
                parentJobId: job.id,
                sourceId: null,
                dedupeKey: cleanupJobKey(rootId, discovery.generation),
                operation: "cleanup",
                priority: 200,
                maxAttempts: 3,
                availableAtMs: cleanupParkedAtMs,
              })
              .pipe(Effect.catch(() => Effect.void));
          } else if (job.operation === "probe") {
            if (job.sourceId === null) throw new Error("Job has no source");
            if (Option.isSome(ingest)) yield* ingest.value.ingest(job.sourceId);
            if ((yield* settings.tmdbKey()) !== null && Option.isSome(tmdb)) {
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
              if (source != null) {
                const enrichmentRun = yield* repositories.scanning.startRun({
                  runId: newUuid(),
                  libraryId: source.libraryId,
                  mode: "refresh",
                  startedAtMs: nowMs,
                });
                yield* repositories.scanning.createJob({
                  id: newUuid(),
                  runId: enrichmentRun.id,
                  parentJobId: null,
                  sourceId: job.sourceId,
                  dedupeKey: `metadata:${job.sourceId}`,
                  operation: "metadata",
                  priority: 100,
                  maxAttempts: 3,
                  availableAtMs: nowMs,
                });
              }
            }
          } else if (job.operation === "metadata") {
            if (job.sourceId === null) throw new Error("Job has no source");
            if (Option.isSome(tmdb)) yield* tmdb.value.enrichSource(job.sourceId);
          } else if (job.operation === "cleanup") {
            const { rootId, generation } = parseCleanupJobKey(job.dedupeKey);
            yield* scanner.cleanup(job.runId, rootId, generation);
          } else if (job.operation === "artwork" || job.operation === "analyze") {
            if (job.sourceId !== null && Option.isSome(ingest))
              yield* ingest.value.ingest(job.sourceId);
          }
        }),
      );
      if (Exit.isSuccess(outcome)) {
        yield* database
          .update(scanJobs)
          .set({
            status: "succeeded",
            errorCode: null,
            errorMessage: null,
            finishedAtMs: nowMs,
            lockedAtMs: null,
            lockedBy: null,
          })
          .where(
            and(
              eq(scanJobs.id, job.id),
              eq(scanJobs.status, "running"),
              eq(scanJobs.lockedBy, job.lockedBy ?? ""),
            ),
          );
        if (job.operation === "discover") yield* settleCleanups(job.runId, nowMs);
        yield* finishRunIfDone(job.runId, nowMs);
        return true;
      } else {
        const cause = Cause.squash(outcome.cause);
        const retry = job.attempts < job.maxAttempts;
        const delay = retryDelayMs(job.attempts);
        yield* database
          .update(scanJobs)
          .set({
            status: retry ? "queued" : "failed",
            availableAtMs: retry ? nowMs + delay : job.availableAtMs,
            startedAtMs: retry ? null : job.startedAtMs,
            finishedAtMs: retry ? null : nowMs,
            lockedAtMs: null,
            lockedBy: null,
            errorCode: "JOB_FAILED",
            errorMessage: cause instanceof Error ? cause.message : "Job failed",
          })
          .where(
            and(
              eq(scanJobs.id, job.id),
              eq(scanJobs.status, "running"),
              eq(scanJobs.lockedBy, job.lockedBy ?? ""),
            ),
          );
        if (!retry && job.operation === "discover") yield* settleCleanups(job.runId, nowMs);
        if (!retry) yield* finishRunIfDone(job.runId, nowMs);
        return true;
      }
    });

    const start = async (signal: AbortSignal): Promise<void> => {
      await Effect.runPromise(
        queueMissingMetadata(Date.now()).pipe(Effect.catch(() => Effect.succeed(0))),
      );
      while (!signal.aborted) {
        await Effect.runPromise(recover(Date.now()).pipe(Effect.catch(() => Effect.void)));
        const didWork = await Effect.runPromise(
          runOne(Date.now()).pipe(Effect.catch(() => Effect.succeed(false))),
        );
        if (!didWork) await Bun.sleep(100);
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
