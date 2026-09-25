import { DatabaseWithMigrationsLive } from "@lumen/database";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { makeServerConfig } from "../config/ServerConfig";

const program = Effect.gen(function* () {
  const config = yield* makeServerConfig();
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }));
  yield* Effect.scoped(
    Effect.provide(Effect.void, DatabaseWithMigrationsLive({ filename: config.databasePath })),
  );
});

await Effect.runPromise(program).catch((cause) => {
  console.error(
    "Database migration failed",
    cause instanceof Error ? cause.message : "unknown error",
  );
  process.exitCode = 1;
});
