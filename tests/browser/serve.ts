// Starts a server with deterministic data for the browser tests: an admin account, a movie and a
// show the browser can play, and one movie whose file is not media at all.
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newUuid } from "../../apps/server/src/core/Security";
import { startServer } from "../../apps/server/src/Runtime";
import { seedPlaybackFixture } from "../helpers/playback";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "lumen-browser-test-"));
const databasePath = join(root, "server.sqlite");
const seeded = await seedPlaybackFixture(root, databasePath);

// "Clip" keeps the fixture's placeholder bytes, which no browser can play. Add a real film, and a
// show whose episodes are copies of it.
const playable = join(repository, "tests/fixtures/playback.mp4");
const playableSize = (await stat(playable)).size;
const database = new Database(databasePath);
const now = Date.now();
let sources = 1;

const addContainer = (kind: "show" | "season", title: string, parent?: { id: string; index: number }): string => {
  const id = newUuid();
  database.run(
    `INSERT INTO catalog_items(id, library_id, kind, parent_id, title, sort_title, index_number, metadata_state, added_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    [id, seeded.libraryId, kind, parent?.id ?? null, title, title.toLowerCase(), parent?.index ?? null, now, now],
  );
  return id;
};

const addPlayable = async (
  kind: "movie" | "episode",
  title: string,
  parent?: { id: string; index: number },
): Promise<void> => {
  const ids = { source: newUuid(), video: newUuid(), audio: newUuid(), track: newUuid(), item: newUuid() };
  const inode = String(++sources);
  const relativePath = `film-${inode}.mp4`;
  await copyFile(playable, join(root, relativePath));
  database.run(
    `INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
     SELECT ?, library_id, root_id, ?, ?, 'local', ?, ?, ?, ? FROM media_sources LIMIT 1`,
    [ids.source, relativePath, join(root, relativePath), playableSize, now, inode, now],
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
     VALUES (?, ?, ?, ?, ?, ?, 5000, 0, ?, ?)`,
    [ids.track, seeded.libraryId, ids.source, ids.video, title, title.toLowerCase(), now, now],
  );
  database.run(
    `INSERT INTO catalog_items(id, library_id, kind, parent_id, title, sort_title, index_number, duration_seconds, metadata_state, added_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 5, 'local', ?, ?)`,
    [ids.item, seeded.libraryId, kind, parent?.id ?? null, title, title.toLowerCase(), parent?.index ?? null, now, now],
  );
  database.run(
    "INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (?, ?, 1, 1)",
    [ids.item, ids.source],
  );
};

await addPlayable("movie", "Film");
const show = addContainer("show", "Harbor Lights");
const seasons = [
  ["Arrival", "The Ferry", "Low Tide", "Night Watch", "Signal Fire", "Breakwater"],
  ["Landfall", "The Lighthouse Keeper", "Storm Glass", "Open Water"],
];
for (const [seasonIndex, titles] of seasons.entries()) {
  const season = addContainer("season", `Season ${seasonIndex + 1}`, { id: show, index: seasonIndex + 1 });
  for (const [episodeIndex, title] of titles.entries())
    await addPlayable("episode", title, { id: season, index: episodeIndex + 1 });
}
database.close();

const server = await startServer({
  databasePath,
  dataDir: root,
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
