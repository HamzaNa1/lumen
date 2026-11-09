import { stat } from "node:fs/promises";
import { Database, DatabaseLive } from "@lumen/database";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { makeServerConfig } from "../config/ServerConfig";
import { createLogger } from "../core/Logger";

const config = await Effect.runPromise(makeServerConfig());
const logger = createLogger({ level: config.logLevel, format: config.logFormat }).child({
  component: "database",
});
try {
  const before = await stat(config.databasePath);
  const started = performance.now();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.run(sql`VACUUM`);
      }).pipe(Effect.provide(DatabaseLive({ filename: config.databasePath }))),
    ),
  );
  logger.info("database_compacted", {
    durationMs: Math.round(performance.now() - started),
    beforeBytes: before.size,
    afterBytes: (await stat(config.databasePath)).size,
  });
} catch (cause) {
  logger.error("database_compaction_failed", {}, cause);
  process.exitCode = 1;
}
