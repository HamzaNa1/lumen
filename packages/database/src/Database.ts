import * as Sqlite from "@effect/sql-sqlite-bun/SqliteClient";
import { sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { EffectSQLiteBunDatabase } from "drizzle-orm/effect-sqlite-bun";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import { Context, Effect, Layer } from "effect";

export type DatabaseClient = EffectSQLiteBunDatabase & {
  readonly $client: Sqlite.SqliteClient;
};

export class Database extends Context.Service<Database, DatabaseClient>()(
  "@lumen/database/Database",
) {}

export const makeDatabase = Effect.fn("Database.make")(function* () {
  const database = yield* SQLiteBunDrizzle.makeWithDefaults();
  yield* database.run(sql`PRAGMA foreign_keys = ON`);
  yield* database.run(sql`PRAGMA busy_timeout = 5000`);
  return database;
});

export const DatabaseLive = (
  config: Sqlite.SqliteClientConfig,
): Layer.Layer<Database, EffectDrizzleQueryError> =>
  Layer.effect(Database, makeDatabase()).pipe(Layer.provide(Sqlite.layer(config)));
