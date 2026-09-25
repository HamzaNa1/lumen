import { Database, sql } from "@lumen/database";
import type { ServerConfig } from "../config/Config";
import { Context, Effect, Exit, Layer } from "effect";
import { LibraryWatcher } from "./LibraryWatcher";

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

const waitForNextTick = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const finish = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", finish);
    resolve();
  };
  const timeout = setTimeout(finish, 1_000);
  signal.addEventListener("abort", finish, { once: true });
});

export const makeScheduledJobService = (config?: ServerConfig) => Effect.gen(function* () {
  const database = yield* Database;
  const watcher = yield* LibraryWatcher;
  const definitions: ReadonlyArray<ScheduledJobDefinition> = [{
    name: "library-watcher",
    intervalMs: config?.libraryWatchIntervalMs ?? 60_000,
    run: watcher.check,
  }];

  const runDue: ScheduledJobServiceShape["runDue"] = Effect.fn("ScheduledJobs.runDue")(function* (nowMs) {
    for (const definition of definitions) {
      yield* database.run(sql`
        INSERT INTO server_scheduled_jobs(name, interval_ms, next_run_at_ms, updated_at_ms)
        VALUES (${definition.name}, ${definition.intervalMs}, ${nowMs}, ${nowMs})
        ON CONFLICT(name) DO UPDATE SET interval_ms = excluded.interval_ms,
          next_run_at_ms = min(server_scheduled_jobs.next_run_at_ms, excluded.next_run_at_ms + excluded.interval_ms),
          updated_at_ms = excluded.updated_at_ms
        WHERE server_scheduled_jobs.interval_ms <> excluded.interval_ms
      `);
    }

    let executed = 0;
    for (const definition of definitions) {
      const claimed = yield* database.get<{ name: string }>(sql`
        UPDATE server_scheduled_jobs
        SET next_run_at_ms = ${nowMs + definition.intervalMs}, last_started_at_ms = ${nowMs},
          last_finished_at_ms = NULL, last_error = NULL, updated_at_ms = ${nowMs}
        WHERE name = ${definition.name} AND next_run_at_ms <= ${nowMs}
          AND (last_started_at_ms IS NULL OR last_finished_at_ms IS NOT NULL
            OR last_started_at_ms < ${nowMs - (config?.scanLeaseMs ?? 300_000)})
        RETURNING name
      `);
      if (claimed == null) continue;

      const outcome = yield* Effect.exit(definition.run(nowMs));
      const finishedAtMs = Date.now();
      if (Exit.isSuccess(outcome)) {
        yield* database.run(sql`
          UPDATE server_scheduled_jobs
          SET last_finished_at_ms = ${finishedAtMs}, last_error = NULL, updated_at_ms = ${finishedAtMs}
          WHERE name = ${definition.name} AND last_started_at_ms = ${nowMs}
        `);
      } else {
        yield* database.run(sql`
          UPDATE server_scheduled_jobs
          SET last_finished_at_ms = ${finishedAtMs}, last_error = ${errorMessage(outcome.cause)}, updated_at_ms = ${finishedAtMs}
          WHERE name = ${definition.name} AND last_started_at_ms = ${nowMs}
        `);
      }
      executed += 1;
    }
    return executed;
  });

  const start = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      await Effect.runPromise(runDue(Date.now()).pipe(Effect.catch(() => Effect.succeed(0))));
      if (!signal.aborted) await waitForNextTick(signal);
    }
  };

  return { runDue, start };
});

export class ScheduledJobService extends Context.Service<ScheduledJobService, ScheduledJobServiceShape>()(
  "@lumen/server/ScheduledJobs",
) {}

export const ScheduledJobServiceLive = Layer.effect(ScheduledJobService, makeScheduledJobService());
export const ScheduledJobServiceLiveWithConfig = (config: ServerConfig) =>
  Layer.effect(ScheduledJobService, makeScheduledJobService(config));
