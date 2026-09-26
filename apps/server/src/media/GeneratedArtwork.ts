import { artwork, type DatabaseClient, serverScheduledJobs } from "@lumen/database";
import { like, sql } from "drizzle-orm";
import { Effect } from "effect";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// Artwork downloaded from metadata providers is stored once per content hash
// and may be shared by several libraries, so files are only removed once no
// artwork row references them.
export const generatedArtworkDir = (dataDir: string): string => join(dataDir, "artwork");

export const artworkSweepJobName = "artwork-sweep";
export const artworkSweepIntervalMs = 6 * 60 * 60 * 1000;
// Files this new may belong to a download whose artwork row is not written yet.
const sweepGraceMs = 10 * 60 * 1000;

type Writer = Pick<DatabaseClient, "insert">;

// Durably schedules a sweep, in the caller's transaction, after artwork rows
// have been deleted.
export const queueArtworkSweep = (database: Writer, nowMs: number) =>
  database
    .insert(serverScheduledJobs)
    .values({
      name: artworkSweepJobName,
      intervalMs: artworkSweepIntervalMs,
      nextRunAtMs: nowMs,
      updatedAtMs: nowMs,
    })
    .onConflictDoUpdate({
      target: serverScheduledJobs.name,
      set: {
        nextRunAtMs: sql`min(${serverScheduledJobs.nextRunAtMs}, ${nowMs})`,
        updatedAtMs: nowMs,
      },
    });

// Deletes generated artwork files that no artwork row references.
export const sweepGeneratedArtwork = Effect.fn("GeneratedArtwork.sweep")(function* (
  database: DatabaseClient,
  dataDir: string,
  nowMs: number,
) {
  const directory = generatedArtworkDir(dataDir);
  const names = yield* Effect.tryPromise(() => readdir(directory)).pipe(
    Effect.catch(() => Effect.succeed([] as string[])),
  );
  const referenced = new Set(
    (yield* database
      .select({ path: artwork.relativePath })
      .from(artwork)
      .where(like(artwork.relativePath, `${directory}%`))).map((row) => row.path),
  );
  let deleted = 0;
  for (const name of names) {
    const path = join(directory, name);
    if (referenced.has(path)) continue;
    const removed = yield* Effect.tryPromise(async () => {
      const details = await lstat(path);
      if (!details.isFile() || details.mtimeMs > nowMs - sweepGraceMs) return false;
      await unlink(path);
      return true;
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (removed) deleted += 1;
  }
  console.info("artwork_sweep_completed", { filesDeleted: deleted });
  return deleted;
});
