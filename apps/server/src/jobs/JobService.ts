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
import { and, asc, count, eq, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import type { ServerConfig } from "../config/Config";
import { Context, Effect, Exit, Layer, Option } from "effect";
import { newUuid } from "../core/Security";
import { MediaIngest } from "../media/MediaIngest";
import { TmdbProvider } from "../media/Tmdb";
import { Scanner } from "../services/Scanner";
import { MetadataSettings } from "../services/MetadataSettings";

export interface JobServiceShape {
  readonly recover: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly runOne: (nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly refresh: (itemId: string, nowMs: number) => Effect.Effect<void, unknown>;
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
        const run = yield* repositories.scanning.startRun({
          runId: newUuid(),
          libraryId: item.libraryId,
          mode: "refresh",
          startedAtMs: nowMs,
        });
        for (const source of sources)
          yield* repositories.scanning.createJob({
            id: newUuid(),
            runId: run.id,
            parentJobId: null,
            sourceId: source.sourceId,
            dedupeKey: `metadata:refresh:${source.sourceId}:${nowMs}`,
            operation: "metadata",
            priority: 300,
            maxAttempts: 3,
            availableAtMs: nowMs,
          });
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

    const recover: JobServiceShape["recover"] = Effect.fn("JobService.recover")(function* (nowMs) {
      const rows = yield* database
        .select({ id: scanJobs.id })
        .from(scanJobs)
        .where(
          and(
            eq(scanJobs.status, "running"),
            isNotNull(scanJobs.lockedAtMs),
            lt(scanJobs.lockedAtMs, nowMs - (config?.scanLeaseMs ?? 300_000)),
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
      }
      return rows.length;
    });

    const runOne: JobServiceShape["runOne"] = Effect.fn("JobService.runOne")(function* (nowMs) {
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
            yield* scanner.discover(job.runId, rootId);
            yield* repositories.scanning
              .createJob({
                id: newUuid(),
                runId: job.runId,
                parentJobId: job.id,
                sourceId: null,
                dedupeKey: `cleanup:${rootId}`,
                operation: "cleanup",
                priority: 200,
                maxAttempts: 3,
                availableAtMs: nowMs,
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
            const rootId = job.dedupeKey.slice("cleanup:".length);
            yield* scanner.cleanup(job.runId, rootId);
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
        const remaining = yield* database
          .select({ count: count() })
          .from(scanJobs)
          .where(
            and(eq(scanJobs.runId, job.runId), inArray(scanJobs.status, ["queued", "running"])),
          )
          .get();
        if ((remaining?.count ?? 0) === 0)
          yield* repositories.scanning.finishRun({
            runId: job.runId,
            status: "succeeded",
            nowMs,
            errorCode: null,
            errorMessage: null,
          });
        return true;
      } else {
        const cause = outcome.cause;
        const retry = job.attempts < job.maxAttempts;
        const delay = Math.min(60_000, 2 ** Math.min(10, job.attempts) * 1_000);
        yield* database
          .update(scanJobs)
          .set({
            status: retry ? "queued" : "failed",
            availableAtMs: nowMs + delay,
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
        if (!retry)
          yield* repositories.scanning
            .finishRun({
              runId: job.runId,
              status: "failed",
              nowMs,
              errorCode: "JOB_FAILED",
              errorMessage: "A scan job exhausted its retries",
            })
            .pipe(Effect.catch(() => Effect.void));
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
