import { Database } from "bun:sqlite";
import { Effect } from "../../../../packages/database/node_modules/effect/dist/index.js";
import { DatabaseWithMigrationsLive } from "../../../../packages/database/src/index";

// Prints each startup event as a JSON line. An optional `kill:<event>` kills the process the
// moment that event is reported, simulating a crash or forced restart at that point, and
// `write:<event>` attempts a valid write from another connection at that moment.
const [filename, migrationsFolder, interference = ""] = process.argv.slice(2);
if (!filename || !migrationsFolder) throw new Error("Database path and migrations are required");
const [action, at] = interference.split(":");
const writeConcurrently = (path: string) => {
  const other = new Database(path);
  try {
    other.exec("PRAGMA busy_timeout = 0");
    other.exec(
      "INSERT INTO libraries(id,name,slug,created_at_ms,updated_at_ms) VALUES('concurrent','Concurrent','concurrent',1,1)",
    );
    return { type: "concurrent_write", blocked: false };
  } catch {
    return { type: "concurrent_write", blocked: true };
  } finally {
    other.close();
  }
};
await Effect.runPromise(
  Effect.scoped(
    Effect.provide(
      Effect.void,
      DatabaseWithMigrationsLive(
        { filename },
        {
          migrationsFolder,
          observe: (event) => {
            console.log(JSON.stringify(event));
            if (event.type !== at) return;
            if (action === "kill") process.kill(process.pid, "SIGKILL");
            if (action === "write") console.log(JSON.stringify(writeConcurrently(filename)));
          },
        },
      ),
    ),
  ),
).catch(() => {
  process.exitCode = 1;
});
