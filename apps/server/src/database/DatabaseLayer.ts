import { DatabaseWithMigrationsLive } from "@lumen/database";
import { Layer } from "effect";
import type { ServerConfig } from "../config/Config";
import { migrateServerDatabase } from "./ServerMigrations";

export const makeDatabaseLayers = (config: ServerConfig) => {
  const database = DatabaseWithMigrationsLive({ filename: config.databasePath });
  const migrated = Layer.effectDiscard(migrateServerDatabase()).pipe(Layer.provide(database));
  return migrated.pipe(Layer.provideMerge(database));
};
