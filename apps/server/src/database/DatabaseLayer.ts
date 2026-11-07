import { DatabaseWithMigrationsLive } from "@lumen/database";
import type { ServerConfig } from "../config/Config";
import type { Logger } from "../core/Logger";

export const makeDatabaseLayers = (config: ServerConfig, logger: Logger) => {
  const log = logger.child({ component: "database" });
  return DatabaseWithMigrationsLive(
    { filename: config.databasePath },
    {
      observe: ({ type, ...fields }) =>
        (type === "foreign_key_check_failed" ? log.error : log.info)(`database_${type}`, fields),
    },
  );
};
