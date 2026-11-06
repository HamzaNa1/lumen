import { Effect } from "../../../../packages/database/node_modules/effect/dist/index.js";
import { DatabaseWithMigrationsLive } from "../../../../packages/database/src/index";

// Prints each startup event as a JSON line. An optional event name kills the process the
// moment that event is reported, simulating a crash or forced restart at that point.
const [filename, migrationsFolder, killAt] = process.argv.slice(2);
if (!filename || !migrationsFolder) throw new Error("Database path and migrations are required");
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
            if (event.type === killAt) process.kill(process.pid, "SIGKILL");
          },
        },
      ),
    ),
  ),
).catch(() => {
  process.exitCode = 1;
});
