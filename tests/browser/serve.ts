// Starts a server with deterministic data for the browser tests: an admin account, one movie the
// browser can play, and one whose file is not media at all.
import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newUuid } from "../../apps/server/src/core/Security";
import { runMediaProcess } from "../../apps/server/src/media/MediaProcess";
import { startServer } from "../../apps/server/src/Runtime";
import { seedPlaybackFixture } from "../helpers/playback";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "lumen-browser-test-"));
const media = join(root, "media");
const dataDir = join(root, "data");
await Promise.all([mkdir(media), mkdir(dataDir)]);
const databasePath = join(dataDir, "server.sqlite");
const seeded = await seedPlaybackFixture(media, databasePath);

// "Clip" keeps the fixture's placeholder bytes, which no browser can play. Add a real film.
const moviePath = join(media, "film.mp4");
await copyFile(join(repository, "tests/fixtures/playback.mp4"), moviePath);
const database = new Database(databasePath);
const addFilm = async (relativePath: string, title: string, durationMs: number) => {
  const ids = {
    source: newUuid(),
    video: newUuid(),
    audio: newUuid(),
    track: newUuid(),
    item: newUuid(),
  };
  const path = join(media, relativePath);
  const details = await stat(path);
  const now = Date.now();
  database.run(
    `INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
     SELECT ?, library_id, root_id, ?, ?, 'local', ?, ?, ?, ? FROM media_sources LIMIT 1`,
    [ids.source, relativePath, path, details.size, details.mtimeMs, String(details.ino), now],
  );
  database.run(
    "INSERT INTO streams(id, source_id, kind, container, codec, ordinal, is_default) VALUES (?, ?, 'video', 'mp4', 'h264', 0, 1)",
    [ids.video, ids.source],
  );
  database.run(
    "INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default) VALUES (?, ?, 'audio', 'mp4', 'aac', 'eng', 'English', 1, 1)",
    [ids.audio, ids.source],
  );
  database.run(
    `INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, duration_ms, is_explicit, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      ids.track,
      seeded.libraryId,
      ids.source,
      ids.video,
      title,
      title.toLowerCase(),
      durationMs,
      now,
      now,
    ],
  );
  database.run(
    `INSERT INTO catalog_items(id, library_id, kind, title, sort_title, duration_seconds, metadata_state, added_at_ms, updated_at_ms)
     VALUES (?, ?, 'movie', ?, ?, ?, 'local', ?, ?)`,
    [ids.item, seeded.libraryId, title, title.toLowerCase(), durationMs / 1000, now, now],
  );
  database.run(
    "INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (?, ?, 1, 1)",
    [ids.item, ids.source],
  );
};
await addFilm("film.mp4", "Film", 5000);
// A longer stream-copy fixture lets tests observe bounded paused fetch-ahead and distant seeks.
const longPath = join(media, "long-film.mp4");
await runMediaProcess(
  [
    "ffmpeg",
    "-nostdin",
    "-v",
    "error",
    "-stream_loop",
    "5",
    "-i",
    moviePath,
    "-c",
    "copy",
    longPath,
  ],
  { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
);
await addFilm("long-film.mp4", "Long film", 120_000);
// Each network profile gets an independent cold package, followed by warm-cache samples.
for (const profile of ["local", "150ms-4Mbps"]) {
  const filename = `benchmark-${profile}.mp4`;
  await copyFile(moviePath, join(media, filename));
  await addFilm(filename, `Benchmark ${profile}`, 20_000);
}
database.close();

const server = await startServer({
  databasePath,
  dataDir,
  managedStreaming: true,
  streamFreeReserveBytes: 0,
  host: "127.0.0.1",
  port: Number(process.env.LUMEN_BROWSER_TEST_PORT ?? 3277),
  logLevel: "warn",
  loginAttemptsPerMinute: 1_000,
  maxRequestsPerMinute: 100_000,
  // The tests exercise the build that would ship.
  webApp: "required",
});
const stop = async (): Promise<void> => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
