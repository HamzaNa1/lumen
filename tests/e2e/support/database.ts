import { DatabaseSync } from "node:sqlite";

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
