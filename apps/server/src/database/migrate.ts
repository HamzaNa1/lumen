import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseWithMigrationsLive } from "@lumen/database";
import { Effect } from "effect";
import { makeServerConfig } from "../config/ServerConfig";
import { createLogger } from "../core/Logger";

let logger = createLogger().child({ component: "database" });

const program = Effect.gen(function* () {
  const config = yield* makeServerConfig();
  logger = createLogger({ level: config.logLevel, format: config.logFormat }).child({
    component: "database",
  });
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
