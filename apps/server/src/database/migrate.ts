import { Database, DatabaseWithMigrationsLive } from "@lumen/database";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { makeServerConfig } from "../config/ServerConfig";
import { migrateServerDatabase } from "./ServerMigrations";

const program = Effect.gen(function* () {
  const config = yield* makeServerConfig();
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }));
  yield* Effect.gen(function* () {
    yield* Database;
    yield* migrateServerDatabase();
  }).pipe(Effect.provide(DatabaseWithMigrationsLive({ filename: config.databasePath })));
});

await Effect.runPromise(program).catch((cause) => {
  console.error("Database migration failed", cause instanceof Error ? cause.message : "unknown error");
  process.exitCode = 1;
});
