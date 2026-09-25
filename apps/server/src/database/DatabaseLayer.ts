import { DatabaseWithMigrationsLive } from "@lumen/database";
import type { ServerConfig } from "../config/Config";

export const makeDatabaseLayers = (config: ServerConfig) =>
  DatabaseWithMigrationsLive({ filename: config.databasePath });
