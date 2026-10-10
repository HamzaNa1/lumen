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
// show whose episodes play the same footage and share one still.
const database = new Database(databasePath);
const now = Date.now();
let files = 0;
const addItem = (
  kind: string,
  title: string,
  parent: { readonly id: string; readonly indexNumber: number } | null = null,
): string => {
  const id = newUuid();
  database.run(
    `INSERT INTO catalog_items(id, library_id, parent_id, index_number, kind, title, sort_title, duration_seconds, metadata_state, added_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    [
      id,
      seeded.libraryId,
      parent?.id ?? null,
      parent?.indexNumber ?? null,
      kind,
      title,
      title.toLowerCase(),
      kind === "movie" || kind === "episode" ? 20 : null,
      now,
      now,
    ],
  );
  return id;
};
const stillPath = join(root, "still.png");
await copyFile(join(repository, "tests/fixtures/still.png"), stillPath);
const still = newUuid();
database.run(
  `INSERT INTO artwork(id, library_id, kind, mime_type, width, height, byte_size, content_hash, relative_path, created_at_ms)
   VALUES (?, ?, 'other', 'image/png', 480, 270, ?, ?, ?, ?)`,
  [
    still,
    seeded.libraryId,
    (await stat(stillPath)).size,
    new Bun.CryptoHasher("sha256").update(await Bun.file(stillPath).bytes()).digest("hex"),
    stillPath,
    now,
  ],
);
const addPlayable = async (
  kind: "movie" | "episode",
  title: string,
  parent: { readonly id: string; readonly indexNumber: number } | null = null,
): Promise<void> => {
  const ids = { source: newUuid(), video: newUuid(), audio: newUuid(), track: newUuid() };
  const name = `playable-${++files}.mp4`;
  const path = join(root, name);
  await copyFile(join(repository, "tests/fixtures/playback.mp4"), path);
  database.run(
    `INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
     SELECT ?, library_id, root_id, ?, ?, 'local', ?, ?, ?, ? FROM media_sources LIMIT 1`,
    [ids.source, name, path, (await stat(path)).size, now, `playable-${files}`, now],
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
     VALUES (?, ?, ?, ?, ?, ?, 20000, 0, ?, ?)`,
    [ids.track, seeded.libraryId, ids.source, ids.video, title, title.toLowerCase(), now, now],
  );
  const item = addItem(kind, title, parent);
  database.run(
    "INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (?, ?, 1, 1)",
    [item, ids.source],
  );
  if (kind === "episode")
    database.run(
      "INSERT INTO catalog_item_artwork(item_id, role, artwork_id, source) VALUES (?, 'still', ?, 'local')",
      [item, still],
    );
};
await addPlayable("movie", "Film");
const show = addItem("show", "Serial");
const firstSeason = addItem("season", "Season 1", { id: show, indexNumber: 1 });
const secondSeason = addItem("season", "Season 2", { id: show, indexNumber: 2 });
await addPlayable("episode", "Pilot", { id: firstSeason, indexNumber: 1 });
await addPlayable("episode", "Second", { id: firstSeason, indexNumber: 2 });
await addPlayable("episode", "Return", { id: secondSeason, indexNumber: 1 });
// Long enough that a drawer listing it has to scroll to reach an episode in the middle.
const longShow = addItem("show", "Harbor Lights");
const longSeasons = [
  ["Arrival", "The Ferry", "Low Tide", "Night Watch", "Signal Fire", "Breakwater"],
  ["Landfall", "The Lighthouse Keeper", "Storm Glass", "Open Water"],
];
for (const [seasonIndex, titles] of longSeasons.entries()) {
  const season = addItem("season", `Season ${seasonIndex + 1}`, {
    id: longShow,
    indexNumber: seasonIndex + 1,
  });
  for (const [episodeIndex, title] of titles.entries())
    await addPlayable("episode", title, { id: season, indexNumber: episodeIndex + 1 });
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
