import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { Effect, Layer } from "effect";
import { Database, type DatabaseClient, DatabaseLive, type DatabaseTransaction } from "./Database";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Reported synchronously before and after each startup phase that can block on a large database. */
export type DatabaseStartupEvent =
  | { readonly type: "open_started" }
  | { readonly type: "open_completed"; readonly durationMs: number }
  | { readonly type: "migrations_started" }
  | { readonly type: "migrations_completed"; readonly applied: number; readonly durationMs: number }
  | { readonly type: "foreign_key_check_started" }
  | { readonly type: "foreign_key_check_skipped" }
  | { readonly type: "foreign_key_check_completed"; readonly durationMs: number }
  | {
      readonly type: "foreign_key_check_failed";
      readonly violations: number;
      readonly durationMs: number;
    };

export interface MigrationOptions {
  readonly migrationsFolder?: string;
  readonly observe?: (event: DatabaseStartupEvent) => void;
}

const ignore = (): void => undefined;
const elapsedSince = (startedAt: number): number => Math.round(performance.now() - startedAt);

const appliedMigrationHashes = (database: DatabaseClient | DatabaseTransaction) =>
  Effect.gen(function* () {
    const tables = yield* database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`,
    );
    if (tables.length === 0) return [];
    const rows = yield* database.all<{ hash: string }>(
      sql`SELECT hash FROM __drizzle_migrations ORDER BY id`,
    );
    return rows.map(({ hash }) => hash);
  });

/**
 * Validation is recorded against the migrations the database has applied, not the application
 * version, so any newly committed migration invalidates it. The record is written in the same
 * transaction as the check that justified it, so a failed or interrupted check leaves the
 * previous record, which names a different migration state, and the next startup checks again.
 */
const validateForeignKeys = (
  database: DatabaseClient,
  observe: (event: DatabaseStartupEvent) => void,
) =>
  Effect.gen(function* () {
    yield* database.run(sql`
      CREATE TABLE IF NOT EXISTS __lumen_foreign_key_validation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migration_state TEXT NOT NULL,
        validated_at_ms INTEGER NOT NULL
      )
    `);
    const durationMs = yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        // The client only issues a deferred BEGIN. Writing first takes the write lock before any
        // read, so the check and its record share one snapshot and another writer committing
        // mid-check waits for us instead of making the final upgrade to a writer fail.
        yield* transaction.run(sql`UPDATE __lumen_foreign_key_validation SET id = id WHERE 0`);
        const migrationState = createHash("sha256")
          .update((yield* appliedMigrationHashes(transaction)).join("\n"))
          .digest("hex");
        const recorded = yield* transaction.all<{ migration_state: string }>(
          sql`SELECT migration_state FROM __lumen_foreign_key_validation WHERE id = 1`,
        );
        if (recorded[0]?.migration_state === migrationState) return undefined;
        observe({ type: "foreign_key_check_started" });
        const startedAt = performance.now();
        const violations = yield* transaction.all(sql`PRAGMA foreign_key_check`);
        if (violations.length > 0) {
          observe({
            type: "foreign_key_check_failed",
            violations: violations.length,
            durationMs: elapsedSince(startedAt),
          });
          return yield* Effect.die(
            new Error(`Database has ${violations.length} foreign key violations`),
          );
        }
        yield* transaction.run(sql`
          INSERT INTO __lumen_foreign_key_validation (id, migration_state, validated_at_ms)
          VALUES (1, ${migrationState}, ${Date.now()})
          ON CONFLICT (id) DO UPDATE SET
            migration_state = excluded.migration_state,
            validated_at_ms = excluded.validated_at_ms
        `);
        return elapsedSince(startedAt);
      }),
    );
    observe(
      durationMs === undefined
        ? { type: "foreign_key_check_skipped" }
        : { type: "foreign_key_check_completed", durationMs },
    );
  });

/**
 * Migrations that rebuild a table drop the old one, and with foreign keys enforced that drop
 * cascades into every table referencing it. SQLite ignores the pragma inside the migration
 * transaction, so enforcement is switched off around the whole run and the result is checked.
 */
export const migrateDatabase = ({
  migrationsFolder = defaultMigrationsFolder,
  observe = ignore,
}: MigrationOptions = {}) =>
  Effect.gen(function* () {
    const database = yield* Database;
    observe({ type: "migrations_started" });
    const startedAt = performance.now();
    const before = (yield* appliedMigrationHashes(database)).length;
    yield* database.run(sql`PRAGMA foreign_keys = OFF`);
    // Suspended so that reading the migration files, which throws synchronously, is also covered.
    yield* Effect.suspend(() => migrate(database, { migrationsFolder })).pipe(
      Effect.ensuring(Effect.orDie(database.run(sql`PRAGMA foreign_keys = ON`))),
    );
    observe({
      type: "migrations_completed",
      applied: (yield* appliedMigrationHashes(database)).length - before,
      durationMs: elapsedSince(startedAt),
    });
    yield* validateForeignKeys(database, observe);
  });

export const DatabaseWithMigrationsLive = (
  config: Parameters<typeof DatabaseLive>[0],
  options: MigrationOptions = {},
) => {
  const observe = options.observe ?? ignore;
  // Only constructors such as Layer.effect* are memoized; Layer.tap would report once per consumer.
  const opened = Layer.unwrap(
    Effect.sync(() => {
      observe({ type: "open_started" });
      const startedAt = performance.now();
      return Layer.effectDiscard(
        Effect.sync(() => observe({ type: "open_completed", durationMs: elapsedSince(startedAt) })),
      ).pipe(Layer.provideMerge(DatabaseLive(config)));
    }),
  );
  return Layer.effectDiscard(migrateDatabase(options)).pipe(Layer.provideMerge(opened));
};
