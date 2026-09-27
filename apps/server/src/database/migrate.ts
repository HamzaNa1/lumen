import { createLogger } from "../core/Logger";
import { DatabaseWithMigrationsLive } from "@lumen/database";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { makeServerConfig } from "../config/ServerConfig";

let logger = createLogger();

const program = Effect.gen(function* () {
  const config = yield* makeServerConfig();
  logger = createLogger(config.logLevel);
  logger.info("database_migration_started");
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }));
  yield* Effect.scoped(
    Effect.provide(Effect.void, DatabaseWithMigrationsLive({ filename: config.databasePath })),
  );
  logger.info("database_migration_completed");
});

await Effect.runPromise(program).catch((cause) => {
  logger.error("database_migration_failed", {}, cause);
  process.exitCode = 1;
});
