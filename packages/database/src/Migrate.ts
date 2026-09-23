import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { Effect, Layer } from "effect";
import { Database, DatabaseLive } from "./Database";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const migrateDatabase = (migrationsFolder = defaultMigrationsFolder) =>
  Effect.gen(function* () {
    const database = yield* Database;
    yield* migrate(database, { migrationsFolder });
  });

export const DatabaseWithMigrationsLive = (
  config: Parameters<typeof DatabaseLive>[0],
  migrationsFolder = defaultMigrationsFolder,
) =>
  Layer.effectDiscard(migrateDatabase(migrationsFolder)).pipe(
    Layer.provideMerge(DatabaseLive(config)),
  );
