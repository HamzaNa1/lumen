import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { makeMediaIngest } from "../../apps/server/src/media/MediaIngest";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const fakeFfprobe = Layer.succeed(Ffprobe, {
  probe: () =>
    Effect.succeed({
      durationMs: 60_000,
      streams: [
        {
          kind: "video" as const,
          ordinal: 0,
          codec: "h264",
          bitrate: null,
          sampleRateHz: null,
          channels: null,
          width: 1920,
          height: 1080,
          language: null,
          title: null,
          isDefault: true,
        },
      ],
      tags: {},
    }),
});

interface EpisodeRow {
  title: string;
  sortTitle: string;
  overview: string | null;
  year: number | null;
  indexNumber: number | null;
  indexNumberEnd: number | null;
  metadataState: string;
}

interface MetadataRow {
  releaseDate: string | null;
  contentRating: string | null;
  communityRating: number | null;
  genresJson: string;
  studiosJson: string;
  tagsJson: string;
  externalIdsJson: string;
  fieldSourcesJson: string;
  lockedFieldsJson: string;
}

interface ArtworkRow {
  role: string;
  source: string;
}

type ProviderSeed = {
  title: string;
  fieldSourcesJson: string;
  lockedFieldsJson: string;
  externalIdsJson: string;
  releaseDate: string | null;
  contentRating: string | null;
  communityRating: number | null;
  genresJson: string;
  studiosJson: string;
  tagsJson: string;
};

/** How a TMDB fetch would leave the episode the item used to cover. */
const tmdbSeed = (overrides: Partial<ProviderSeed> = {}): ProviderSeed => ({
  title: "Night Out",
  fieldSourcesJson: JSON.stringify({
    title: "tmdb",
    overview: "tmdb",
    year: "tmdb",
    releaseDate: "tmdb",
    contentRating: "tmdb",
    communityRating: "tmdb",
    genres: "tmdb",
    studios: "tmdb",
    tags: "tmdb",
  }),
  lockedFieldsJson: "[]",
  externalIdsJson: JSON.stringify({ tmdb: "2316:4:11", imdb: "tt0604902" }),
  releaseDate: "2008-10-16",
  contentRating: "TV-14",
  communityRating: 8.7,
  genresJson: JSON.stringify(["Comedy"]),
  studiosJson: JSON.stringify(["Deedle-Dee Productions"]),
  tagsJson: JSON.stringify(["Workplace"]),
  ...overrides,
});

interface Harness {
  libraryId: string;
  rootPath: string;
  episode: () => Promise<EpisodeRow>;
  metadata: () => Promise<MetadataRow>;
  providerRecordCount: () => Promise<number>;
  artwork: () => Promise<ArtworkRow[]>;
  seedProviderState: (seed: ProviderSeed) => Promise<void>;
  ingest: () => Promise<void>;
  renumberFile: (from: string, to: string) => Promise<void>;
}

const makeHarness = async (relativePath: string): Promise<Harness> => {
  const workspace = await mkdtemp(join(tmpdir(), "lumen-ingest-renumber-"));
  paths.push(workspace);
  const databaseLayer = makeDatabaseLayers({
    databasePath: join(workspace, "server.sqlite"),
  } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer), fakeFfprobe);
  const run = <A>(effect: Effect.Effect<A, unknown, Layer.Success<typeof layer>>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const libraryId = newUuid();
  const rootId = newUuid();
  const rootPath = join(workspace, "shows");
  const sourceId = newUuid();
  const absolutePath = join(rootPath, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "media");

  await run(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.run(
        sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Shows', 'shows', 1, 1, 1)`,
      );
      yield* database.run(
        sql`INSERT INTO library_profiles(library_id, kind) VALUES (${libraryId}, 'shows')`,
      );
      yield* database.run(
        sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${rootPath}, 1, 0, 1, 1)`,
      );
      yield* database.run(
        sql`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms) VALUES (${sourceId}, ${libraryId}, ${rootId}, ${relativePath}, ${absolutePath}, 'local', 5, 1, 'renumber-inode-1', 1)`,
      );
    }),
  );

  const query = <T>(statement: ReturnType<typeof sql>, message: string): Promise<T> =>
    run(
      Effect.gen(function* () {
        const database = yield* Database;
        const row = yield* database.get<T>(statement);
        if (row == null) throw new Error(message);
        return row;
      }),
    );

  await run(
    Effect.gen(function* () {
      const ingest = yield* makeMediaIngest;
      yield* ingest.ingest(sourceId);
    }),
  );

  return {
    libraryId,
    rootPath,
    episode: () =>
      query<EpisodeRow>(
        sql`SELECT title, sort_title AS sortTitle, overview, year, index_number AS indexNumber, index_number_end AS indexNumberEnd, metadata_state AS metadataState FROM catalog_items WHERE kind = 'episode'`,
        "Expected the episode item",
      ),
    metadata: () =>
      query<MetadataRow>(
        sql`SELECT release_date AS releaseDate, content_rating AS contentRating, community_rating AS communityRating, genres_json AS genresJson, studios_json AS studiosJson, tags_json AS tagsJson, external_ids_json AS externalIdsJson, field_sources_json AS fieldSourcesJson, locked_fields_json AS lockedFieldsJson FROM catalog_item_metadata`,
        "Expected a metadata row",
      ),
    providerRecordCount: async () => {
      const counted = await query<{ count: number }>(
        sql`SELECT count(*) AS count FROM provider_records WHERE provider = 'tmdb'`,
        "Expected the provider record count",
      );
      return counted.count;
    },
    artwork: async () =>
      await run(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.all<ArtworkRow>(
            sql`SELECT role, source FROM catalog_item_artwork ORDER BY role`,
          );
        }),
      ),
    seedProviderState: async (seed) => {
      await run(
        Effect.gen(function* () {
          const database = yield* Database;
          const item = yield* database.get<{ itemId: string }>(
            sql`SELECT id AS itemId FROM catalog_items WHERE kind = 'episode'`,
          );
          if (item == null) throw new Error("Expected the episode item");
          const itemId = item.itemId;
          yield* database.run(sql`
            UPDATE catalog_items
            SET title = ${seed.title}, sort_title = ${seed.title.toLowerCase()},
                overview = 'Stale overview for the old episode', year = 2007,
                metadata_state = 'tmdb'
            WHERE id = ${itemId}
          `);
          yield* database.run(sql`
            INSERT INTO catalog_item_metadata(item_id, release_date, content_rating, community_rating,
                genres_json, studios_json, tags_json, external_ids_json, field_sources_json, locked_fields_json)
            VALUES (${itemId}, ${seed.releaseDate}, ${seed.contentRating}, ${seed.communityRating},
                ${seed.genresJson}, ${seed.studiosJson}, ${seed.tagsJson}, ${seed.externalIdsJson},
                ${seed.fieldSourcesJson}, ${seed.lockedFieldsJson})
          `);
          yield* database.run(sql`
            INSERT INTO provider_records(id, item_id, provider, provider_item_id, payload_json, confidence, fetched_at_ms)
            VALUES (${newUuid()}, ${itemId}, 'tmdb', '2316:4:11', '{}', 85, 1)
          `);
          for (const [role, source] of [
            ["still", "tmdb"],
            ["poster", "local"],
            ["backdrop", "user"],
          ] as const) {
            const artworkId = newUuid();
            yield* database.run(sql`
              INSERT INTO artwork(id, library_id, source_id, kind, mime_type, width, height, byte_size, content_hash, relative_path, created_at_ms)
              VALUES (${artworkId}, ${libraryId}, NULL, 'other', 'image/jpeg', 4, 6, 2, ${"a".repeat(64)}, ${join(rootPath, `${role}-${artworkId}.jpg`)}, 1)
            `);
            yield* database.run(sql`
              INSERT INTO catalog_item_artwork(item_id, role, artwork_id, source)
              VALUES (${itemId}, ${role}, ${artworkId}, ${source})
            `);
          }
        }),
      );
    },
    ingest: async () => {
      await run(
        Effect.gen(function* () {
          const ingest = yield* makeMediaIngest;
          yield* ingest.ingest(sourceId);
        }),
      );
    },
    renumberFile: async (from, to) => {
      await rename(join(rootPath, from), join(rootPath, to));
      await run(
        Effect.gen(function* () {
          const database = yield* Database;
          yield* database.run(
            sql`UPDATE media_sources SET relative_path = ${to}, absolute_path = ${join(rootPath, to)} WHERE id = ${sourceId}`,
          );
        }),
      );
    },
  };
};

// Sonarr renames The Office S04E11 onto the TVDB half-hour numbering as S04E15 while TMDB still
// numbers that season by hour-long episodes, so a lookup of episode 15 never answers again.
const officeEpisodeFile = "The Office/Season 4/The Office S04E11 - Night Out.mkv";

describe("media ingest renumber reset", () => {
  test("a start-episode rename drops every provider written value of the old numbering", async () => {
    const harness = await makeHarness(officeEpisodeFile);
    await harness.seedProviderState(tmdbSeed());
    const before = await harness.episode();
    expect(before.metadataState).toBe("tmdb");
    expect(before.indexNumber).toBe(11);

    await harness.renumberFile(officeEpisodeFile, "The Office/Season 4/The Office S04E15.mkv");
    await harness.ingest();

    expect(await harness.episode()).toEqual({
      title: "Episode 15",
      sortTitle: "episode 15",
      overview: null,
      year: null,
      indexNumber: 15,
      indexNumberEnd: null,
      metadataState: "path",
    });
    expect(await harness.metadata()).toEqual({
      releaseDate: null,
      contentRating: null,
      communityRating: null,
      genresJson: "[]",
      studiosJson: "[]",
      tagsJson: "[]",
      externalIdsJson: JSON.stringify({ imdb: "tt0604902" }),
      fieldSourcesJson: "{}",
      lockedFieldsJson: "[]",
    });
    expect(await harness.providerRecordCount()).toBe(0);
    expect(await harness.artwork()).toEqual([
      { role: "backdrop", source: "user" },
      { role: "poster", source: "local" },
    ]);
  });

  test.each([
    {
      name: "a rename onto an episode range abandons the single episode (null to 2)",
      from: "House/Season 1/House S01E01.mkv",
      to: "House/Season 1/House S01E01-E02.mkv",
      indexNumberEnd: 2,
    },
    {
      name: "a rename off an episode range abandons two episodes (2 to null)",
      from: "House/Season 1/House S01E01-E02.mkv",
      to: "House/Season 1/House S01E01.mkv",
      indexNumberEnd: null,
    },
  ])("$name", async ({ from, to, indexNumberEnd }) => {
    const harness = await makeHarness(from);
    await harness.seedProviderState(tmdbSeed());
    expect((await harness.episode()).indexNumberEnd).toBe(from.includes("-E02") ? 2 : null);

    await harness.renumberFile(from, to);
    await harness.ingest();

    const episode = await harness.episode();
    expect(episode.indexNumberEnd).toBe(indexNumberEnd);
    expect(episode.indexNumber).toBe(1);
    expect(episode.metadataState).toBe("path");
    expect(episode.title).toBe("Episode 1");
    expect(await harness.providerRecordCount()).toBe(0);
    expect(JSON.parse((await harness.metadata()).externalIdsJson)).toEqual({
      imdb: "tt0604902",
    });
  });

  test("rescanning the same file leaves provider values alone", async () => {
    const harness = await makeHarness(officeEpisodeFile);
    await harness.seedProviderState(tmdbSeed());

    await harness.ingest();

    const episode = await harness.episode();
    expect(episode).toEqual({
      title: "Night Out",
      sortTitle: "night out",
      overview: "Stale overview for the old episode",
      year: 2007,
      indexNumber: 11,
      indexNumberEnd: null,
      metadataState: "tmdb",
    });
    expect(await harness.metadata()).toEqual({
      releaseDate: "2008-10-16",
      contentRating: "TV-14",
      communityRating: 8.7,
      genresJson: JSON.stringify(["Comedy"]),
      studiosJson: JSON.stringify(["Deedle-Dee Productions"]),
      tagsJson: JSON.stringify(["Workplace"]),
      externalIdsJson: JSON.stringify({ tmdb: "2316:4:11", imdb: "tt0604902" }),
      fieldSourcesJson: JSON.stringify({
        title: "tmdb",
        overview: "tmdb",
        year: "tmdb",
        releaseDate: "tmdb",
        contentRating: "tmdb",
        communityRating: "tmdb",
        genres: "tmdb",
        studios: "tmdb",
        tags: "tmdb",
      }),
      lockedFieldsJson: "[]",
    });
    expect(await harness.providerRecordCount()).toBe(1);
    expect(await harness.artwork()).toEqual([
      { role: "backdrop", source: "user" },
      { role: "poster", source: "local" },
      { role: "still", source: "tmdb" },
    ]);
  });

  test("user, NFO and locked values survive the renumbering reset", async () => {
    const harness = await makeHarness(officeEpisodeFile);
    await harness.seedProviderState(
      tmdbSeed({
        fieldSourcesJson: JSON.stringify({
          title: "tmdb",
          overview: "tmdb",
          year: "tmdb",
          releaseDate: "user",
          contentRating: "tmdb",
          communityRating: "tmdb",
          genres: "nfo",
          studios: "tmdb",
          tags: "tmdb",
        }),
        lockedFieldsJson: JSON.stringify(["studios", "tmdb"]),
      }),
    );

    await harness.renumberFile(officeEpisodeFile, "The Office/Season 4/The Office S04E15.mkv");
    await harness.ingest();

    expect(await harness.metadata()).toEqual({
      releaseDate: "2008-10-16",
      contentRating: null,
      communityRating: null,
      genresJson: JSON.stringify(["Comedy"]),
      studiosJson: JSON.stringify(["Deedle-Dee Productions"]),
      tagsJson: "[]",
      externalIdsJson: JSON.stringify({ tmdb: "2316:4:11", imdb: "tt0604902" }),
      fieldSourcesJson: JSON.stringify({ releaseDate: "user", genres: "nfo", studios: "tmdb" }),
      lockedFieldsJson: JSON.stringify(["studios", "tmdb"]),
    });
    expect(await harness.providerRecordCount()).toBe(0);
    expect((await harness.episode()).title).toBe("Episode 15");
  });

  test("a user edited title keeps the catalog row while provider fields reset", async () => {
    const harness = await makeHarness(officeEpisodeFile);
    await harness.seedProviderState(
      tmdbSeed({
        title: "Custom Title",
        fieldSourcesJson: JSON.stringify({
          title: "user",
          overview: "tmdb",
          year: "tmdb",
          releaseDate: "tmdb",
          contentRating: "tmdb",
          communityRating: "tmdb",
          genres: "tmdb",
          studios: "tmdb",
          tags: "tmdb",
        }),
        lockedFieldsJson: JSON.stringify(["title"]),
      }),
    );

    await harness.renumberFile(officeEpisodeFile, "The Office/Season 4/The Office S04E15.mkv");
    await harness.ingest();

    const episode = await harness.episode();
    expect(episode.title).toBe("Custom Title");
    expect(episode.sortTitle).toBe("custom title");
    expect(episode.overview).toBe(null);
    expect(episode.year).toBe(null);
    // The catalog row keeps the state only while its identity fields stay provider owned.
    expect(episode.metadataState).toBe("tmdb");
    expect(await harness.providerRecordCount()).toBe(0);
  });
});
