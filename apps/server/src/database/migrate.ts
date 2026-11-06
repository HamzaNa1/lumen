import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { makeServerConfig } from "../config/ServerConfig";
import { createLogger } from "../core/Logger";
import { makeDatabaseLayers } from "./DatabaseLayer";

let logger = createLogger();

const program = Effect.gen(function* () {
  const config = yield* makeServerConfig();
  logger = createLogger({ level: config.logLevel, format: config.logFormat });
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }));
  yield* Effect.scoped(Effect.provide(Effect.void, makeDatabaseLayers(config, logger)));
});

await Effect.runPromise(program).catch((cause) => {
  logger.child({ component: "database" }).error("database_migration_failed", {}, cause);
  process.exitCode = 1;
});
