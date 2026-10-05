import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { Effect, Layer } from "effect";
import { Database, DatabaseLive } from "./Database";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Migrations that rebuild a table drop the old one, and with foreign keys enforced that drop
 * cascades into every table referencing it. SQLite ignores the pragma inside the migration
 * transaction, so enforcement is switched off around the whole run and the result is checked.
 */
export const migrateDatabase = (migrationsFolder = defaultMigrationsFolder) =>
  Effect.gen(function* () {
    const database = yield* Database;
    yield* database.run(sql`PRAGMA foreign_keys = OFF`);
    yield* migrate(database, { migrationsFolder }).pipe(
      Effect.ensuring(Effect.orDie(database.run(sql`PRAGMA foreign_keys = ON`))),
    );
    const violations = yield* database.all(sql`PRAGMA foreign_key_check`);
    if (violations.length > 0)
      return yield* Effect.die(
        new Error(`Migrations left ${violations.length} foreign key violations`),
      );
  });

export const DatabaseWithMigrationsLive = (
  config: Parameters<typeof DatabaseLive>[0],
  migrationsFolder = defaultMigrationsFolder,
) =>
  Layer.effectDiscard(migrateDatabase(migrationsFolder)).pipe(
    Layer.provideMerge(DatabaseLive(config)),
  );
