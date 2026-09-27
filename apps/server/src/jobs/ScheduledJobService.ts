import { ServerLogger } from "../core/Logger";
import { backgroundTask } from "./JobLogging";
import { Database, serverScheduledJobs } from "@lumen/database";
import { and, eq, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { ServerConfig } from "../config/Config";
import { Cause, Context, Effect, Exit, Layer } from "effect";
import {
  artworkSweepIntervalMs,
  artworkSweepJobName,
  sweepGeneratedArtwork,
} from "../media/GeneratedArtwork";
import { enqueueServerJob, LIBRARY_WATCHER_JOB } from "./ServerJobs";

// The library watcher tick enqueues durable work for the job worker.
// Artwork sweeps retain their scheduled callback.
interface ScheduledJobDefinition {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: (nowMs: number) => Effect.Effect<unknown, unknown>;
}

export interface ScheduledJobServiceShape {
  readonly runDue: (nowMs: number) => Effect.Effect<number, unknown>;
  readonly start: (signal: AbortSignal) => Promise<void>;
}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  return String(cause);
};

const waitForNextTick = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 1_000);
    signal.addEventListener("abort", finish, { once: true });
  });

export const makeScheduledJobService = (config?: ServerConfig) =>
  Effect.gen(function* () {
    const logger = (yield* ServerLogger).child({ component: "scheduler" });
    const database = yield* Database;
    const definitions: ReadonlyArray<ScheduledJobDefinition> = [
      {
        name: LIBRARY_WATCHER_JOB,
        intervalMs: config?.libraryWatchIntervalMs ?? 60_000,
        run: (nowMs) =>
          enqueueServerJob(database, { kind: LIBRARY_WATCHER_JOB, nowMs, maxAttempts: 3 }),
      },
      ...(config === undefined
        ? []
        : [
            {
              name: artworkSweepJobName,
              intervalMs: artworkSweepIntervalMs,
              run: (nowMs: number) =>
                sweepGeneratedArtwork(database, config.dataDir, nowMs).pipe(
                  Effect.provideService(ServerLogger, logger),
                ),
            },
          ]),
    ];

    const runDue: ScheduledJobServiceShape["runDue"] = Effect.fn("ScheduledJobs.runDue")(
      function* (nowMs) {
        for (const definition of definitions) {
          yield* database
            .insert(serverScheduledJobs)
            .values({
              name: definition.name,
              intervalMs: definition.intervalMs,
              nextRunAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .onConflictDoUpdate({
              target: serverScheduledJobs.name,
              set: {
                intervalMs: definition.intervalMs,
                nextRunAtMs: sql`min(${serverScheduledJobs.nextRunAtMs}, ${nowMs + definition.intervalMs})`,
                updatedAtMs: nowMs,
              },
              setWhere: ne(serverScheduledJobs.intervalMs, definition.intervalMs),
            });
        }

        let executed = 0;
        for (const definition of definitions) {
          const [claimed] = yield* database
            .update(serverScheduledJobs)
            .set({
              nextRunAtMs: nowMs + definition.intervalMs,
              lastStartedAtMs: nowMs,
              lastFinishedAtMs: null,
              lastError: null,
              updatedAtMs: nowMs,
            })
            .where(
              and(
                eq(serverScheduledJobs.name, definition.name),
                lte(serverScheduledJobs.nextRunAtMs, nowMs),
                or(
                  isNull(serverScheduledJobs.lastStartedAtMs),
                  isNotNull(serverScheduledJobs.lastFinishedAtMs),
                  lt(serverScheduledJobs.lastStartedAtMs, nowMs - (config?.scanLeaseMs ?? 300_000)),
                ),
              ),
            )
            .returning({ name: serverScheduledJobs.name });
          if (claimed == null) continue;

          const startedAt = performance.now();
          logger.debug("scheduled_job_started", { operation: definition.name });
          const outcome = yield* Effect.exit(definition.run(nowMs));
          const finishedAtMs = Date.now();
          if (Exit.isSuccess(outcome)) {
            yield* database
              .update(serverScheduledJobs)
              .set({
                lastFinishedAtMs: finishedAtMs,
                lastError: null,
                updatedAtMs: finishedAtMs,
              })
              .where(
                and(
                  eq(serverScheduledJobs.name, definition.name),
                  eq(serverScheduledJobs.lastStartedAtMs, nowMs),
                ),
              );
          } else {
            yield* database
              .update(serverScheduledJobs)
              .set({
                lastFinishedAtMs: finishedAtMs,
                lastError: errorMessage(outcome.cause),
                updatedAtMs: finishedAtMs,
              })
              .where(
                and(
                  eq(serverScheduledJobs.name, definition.name),
                  eq(serverScheduledJobs.lastStartedAtMs, nowMs),
                ),
              );
          }
          logger[Exit.isSuccess(outcome) ? "debug" : "error"](
            "scheduled_job_finished",
            {
              operation: definition.name,
              result: Exit.isSuccess(outcome) ? "succeeded" : "failed",
              durationMs: Math.round(performance.now() - startedAt),
            },
            Exit.isFailure(outcome) ? Cause.squash(outcome.cause) : undefined,
          );
          executed += 1;
        }
        return executed;
      },
    );

    const start = async (signal: AbortSignal): Promise<void> => {
      logger.info("scheduler_started");
      const tick = backgroundTask(logger, "scheduled_jobs", () => runDue(Date.now()), 0);
      try {
        while (!signal.aborted) {
          await tick();
          if (!signal.aborted) await waitForNextTick(signal);
        }
      } finally {
        logger.info("scheduler_stopped");
      }
    };

    return { runDue, start };
  });

export class ScheduledJobService extends Context.Service<
  ScheduledJobService,
  ScheduledJobServiceShape
>()("@lumen/server/ScheduledJobs") {}

export const ScheduledJobServiceLive = Layer.effect(ScheduledJobService, makeScheduledJobService());
export const ScheduledJobServiceLiveWithConfig = (config: ServerConfig) =>
  Layer.effect(ScheduledJobService, makeScheduledJobService(config));
