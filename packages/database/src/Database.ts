import * as Sqlite from "@effect/sql-sqlite-bun/SqliteClient";
import { sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { EffectSQLiteBunDatabase } from "drizzle-orm/effect-sqlite-bun";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import { Context, Effect, Layer } from "effect";

export type DatabaseClient = EffectSQLiteBunDatabase & {
  readonly $client: Sqlite.SqliteClient;
};

export type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

export class Database extends Context.Service<Database, DatabaseClient>()(
  "@lumen/database/Database",
) {}

const makeDatabase = Effect.fn("Database.make")(function* () {
  const database = yield* SQLiteBunDrizzle.makeWithDefaults();
  // Processes opening the file together wait for each other only once a busy timeout is set.
  yield* database.run(sql`PRAGMA busy_timeout = 5000`);
  yield* database.run(sql`PRAGMA journal_mode = WAL`);
  yield* database.run(sql`PRAGMA foreign_keys = ON`);
  return database;
});

export const DatabaseLive = (
  config: Sqlite.SqliteClientConfig,
): Layer.Layer<Database, EffectDrizzleQueryError> =>
  Layer.effect(Database, makeDatabase()).pipe(
    Layer.provide(Sqlite.layer({ ...config, disableWAL: true })),
  );
