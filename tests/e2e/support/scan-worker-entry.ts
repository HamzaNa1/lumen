import "./process-coverage";
import { inspect } from "node:util";
import "./tmdb-origin";
import { Effect } from "../../../apps/server/node_modules/effect/dist/index.js";
import { makeServerConfig } from "../../../apps/server/src/config/ServerConfig";
import { JobService } from "../../../apps/server/src/jobs/JobService";
import { makeLayers } from "../../../apps/server/src/Runtime";
import { Repositories } from "../../../packages/database/src/Repositories";

const config = await Effect.runPromise(makeServerConfig());
await Effect.runPromise<unknown, unknown>(
  Effect.gen(function* () {
    const jobs = yield* JobService;
    const repositories = yield* Repositories;
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.on("message", async (message: { id: string; action: string; nowMs: number }) => {
            try {
              const result = await Effect.runPromise<unknown, unknown>(
                message.action === "claim"
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
          });
          process.once("disconnect", resolve);
          process.send?.({ ready: true });
        }),
    );
  }).pipe(Effect.provide(makeLayers(config))),
);
