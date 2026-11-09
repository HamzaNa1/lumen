import "./process-coverage";
import { inspect } from "node:util";
import "./tmdb-origin";
import "./scan-filesystem-faults";
import { Effect } from "../../../apps/server/node_modules/effect/dist/index.js";
import { makeServerConfig } from "../../../apps/server/src/config/ServerConfig";
import { JobService } from "../../../apps/server/src/jobs/JobService";
import { LibraryWatcher } from "../../../apps/server/src/jobs/LibraryWatcher";
import { ScheduledJobService } from "../../../apps/server/src/jobs/ScheduledJobService";
import { makeLayers } from "../../../apps/server/src/Runtime";

import { type PreparedReconciliation, Scanner } from "../../../apps/server/src/services/Scanner";
import { Repositories } from "../../../packages/database/src/Repositories";

const config = await Effect.runPromise(makeServerConfig());
await Effect.runPromise<unknown, unknown>(
  Effect.gen(function* () {
    const scanner = yield* Scanner;
    const watcher = yield* LibraryWatcher;
    let prepared: PreparedReconciliation | null = null;
    const jobs = yield* JobService;
    const scheduler = yield* ScheduledJobService;
    const repositories = yield* Repositories;
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.on(
            "message",
            async (message: { id: string; action: string; nowMs: number; libraryId?: string }) => {
              try {
                const result = await Effect.runPromise<unknown, unknown>(
                  message.action === "watch"
                    ? watcher.check(message.nowMs)
                    : message.action === "prepare"
                      ? scanner
                          .prepare(message.libraryId ?? "", {
                            mode: "incremental",
                            userInitiated: false,
                          })
                          .pipe(
                            Effect.map((plan) => {
                              prepared = plan;
                              return plan?.plan.stats;
                            }),
                          )
                      : message.action === "apply"
                        ? prepared === null
                          ? Effect.fail(new Error("No prepared plan"))
                          : scanner.apply(prepared, message.nowMs)
                        : message.action === "maintain"
                          ? scheduler.runDue(message.nowMs)
                          : message.action === "claim"
                            ? repositories.scanning.claimNextJob({
                                workerId: `worker-${process.pid}`,
                                nowMs: message.nowMs,
                                operations: [],
                              })
                            : message.action === "recover"
                              ? jobs.recover(message.nowMs)
                              : message.action === "backfill"
                                ? jobs.queueMissingMetadata(message.nowMs)
                                : jobs.runOne(message.nowMs),
                );
                process.send?.({ id: message.id, result: result ?? null });
              } catch (cause) {
                process.send?.({
                  id: message.id,
                  error: inspect(cause, { depth: 10, colors: false }),
                });
              }
            },
          );
          process.once("disconnect", resolve);
          process.send?.({ ready: true });
        }),
    );
  }).pipe(Effect.provide(makeLayers(config))),
);
