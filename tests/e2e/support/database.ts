import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Drizzle applies, in name order, every folder that contains a migration.sql.
export const listMigrations = async (folder: string): Promise<string[]> =>
  (await readdir(folder)).filter((name) => existsSync(join(folder, name, "migration.sql"))).sort();

export function openDatabase(
  path: string,
  options: ConstructorParameters<typeof DatabaseSync>[1] = {},
): DatabaseSync {
  const database = new DatabaseSync(path, options);
  try {
    // Fixture writes share SQLite with the live server and need its same lock-wait policy.
    database.exec("PRAGMA busy_timeout = 5000");
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}
