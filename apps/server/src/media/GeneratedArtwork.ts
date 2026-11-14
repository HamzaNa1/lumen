import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { artwork, type DatabaseClient, serverScheduledJobs } from "@lumen/database";
import { like, sql } from "drizzle-orm";
import { Effect } from "effect";
import { ServerLogger } from "../core/Logger";
import { ARTWORK_VARIANT_NAME, artworkVariantDir } from "./ArtworkVariants";

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

const removeUnkept = (directory: string, keep: (name: string) => boolean, nowMs: number) =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise(() => readdir(directory)).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
    );
    let deleted = 0;
    for (const name of names) {
      if (keep(name)) continue;
      const path = join(directory, name);
      const removed = yield* Effect.tryPromise(async () => {
        const details = await lstat(path);
        if (!details.isFile() || details.mtimeMs > nowMs - sweepGraceMs) return false;
        await unlink(path);
        return true;
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (removed) deleted += 1;
    }
    return deleted;
  });

// Deletes generated artwork files that no artwork row references, and scaled variants of
// revisions no artwork row holds any more.
export const sweepGeneratedArtwork = Effect.fn("GeneratedArtwork.sweep")(function* (
  database: DatabaseClient,
  dataDir: string,
  nowMs: number,
) {
  const directory = generatedArtworkDir(dataDir);
  const referenced = new Set(
    (yield* database
      .select({ path: artwork.relativePath })
      .from(artwork)
      .where(like(artwork.relativePath, `${directory}%`))).map((row) => row.path),
  );
  const revisions = new Set(
    (yield* database.selectDistinct({ hash: artwork.contentHash }).from(artwork)).map(
      (row) => row.hash,
    ),
  );
  const deleted =
    (yield* removeUnkept(directory, (name) => referenced.has(join(directory, name)), nowMs)) +
    (yield* removeUnkept(
      artworkVariantDir(dataDir),
      (name) => revisions.has(ARTWORK_VARIANT_NAME.exec(name)?.[1] ?? ""),
      nowMs,
    ));
  const logger = yield* ServerLogger;
  logger.info("artwork_sweep_completed", { filesDeleted: deleted });
  return deleted;
});
