import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "./support/database";
import { expect, type Item, repository, test } from "./support/server";

const episodeNames = [
  ["S03E10-11", 10, 11],
  ["S03E10-E11", 10, 11],
  ["S03E10E11", 10, 11],
  ["s03e10-e11", 10, 11],
  ["S03E10-E12", 10, 12],
  ["S03E10E11E12", 10, 12],
  ["S03E10-E11-E12", 10, 12],
  ["S03E10-11-12", 10, 12],
  ["S03E10", 10, null],
  ["S03E10-1080p.WEB", 10, null],
  ["S03E10-720p", 10, null],
  ["S03E10 - 11 Monkeys", 10, null],
  ["S03E10.x264-2160", 10, null],
  ["S03E10-11-1080p", 10, 11],
  ["S03E10E11-2160p", 10, 11],
  ["S03E11-10", 11, null],
  ["S03E10-E10", 10, null],
  ["S03E10E12", 10, null],
  ["S03E10E11E13", 10, null],
  ["S03E01-E40", 1, null],
  ["S03E10-11-13", 10, null],
  ["S03E10-E11-E13", 10, null],
  ["S03E10E11-13", 10, null],
  ["S03E10-11-10", 10, null],
  ["S03E10-E11-E1000", 10, null],
  ["S03E10E1000", 10, null],
  ["S03E10-1000", 10, null],
  ["S03E10-E11-E12x", 10, null],
  ["S03E01-E10", 1, 10],
] as const;

test("scanner interprets episode naming variants and malformed ranges through the catalog API", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(
    token,
    "shows",
    episodeNames.map(([name], index) => `Case ${index}/Season 3/Show ${name}.mp4`),
  );
  const shows = await server.items(token, library.id);
  expect(shows).toHaveLength(episodeNames.length);
  for (const [index, [name, number, end]] of episodeNames.entries()) {
    const show = shows.find((show) => show.title === `Case ${index}`);
    expect(show, name).toBeDefined();
    const seasons = await server.api<{ items: Item[] }>(`/items/${show?.id}/children`, { token });
    const episodes = await server.api<{ items: Item[] }>(
      `/items/${seasons.items[0]?.id}/children`,
      { token },
    );
    expect(episodes.items, name).toEqual([
      expect.objectContaining({ indexNumber: number, indexNumberEnd: end }),
    ]);
  }
});

test("local NFO metadata and artwork update on scan, cache by revision and remain access controlled", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", []);
  const folder = join(library.path, "Arrival (2016)");
  await mkdir(folder);
  await server.media(library.path, "Arrival (2016)/Arrival.mp4");
  await writeFile(
    join(folder, "movie.nfo"),
    "<movie><title>Local Arrival</title><year>2016</year><plot>A local synopsis.</plot><genre>Drama</genre></movie>",
  );
  await copyFile(join(repository, "tests/fixtures/still.png"), join(folder, "poster.png"));
  await server.scan(token, library.id, "full");
  const item = (await server.items(token, library.id))[0];
  expect(item).toMatchObject({ title: "Local Arrival" });
  const details = await server.api<{
    item: { id: string; artworkId: string; artworkRevision: string };
  }>(`/items/${item?.id}`, { token });
  expect(details).toMatchObject({ item: { overview: "A local synopsis.", year: 2016 } });
  const url = `/api/v1/artwork/${details.item.artworkId}?revision=${details.item.artworkRevision}`;
  const headers = { authorization: `Bearer ${token}` };
  const artwork = await server.request(url, { headers });
  expect(artwork.status).toBe(200);
  expect(artwork.headers.get("cache-control")).toContain("immutable");
  expect(artwork.headers.get("vary")?.toLowerCase()).toContain("authorization");
  expect(artwork.headers.get("vary")?.toLowerCase()).toContain("cookie");
  expect((await server.request(url)).status).toBe(401);
  await writeFile(
    join(folder, "movie.nfo"),
    "<movie><title>Changed local title</title><plot>New synopsis</plot></movie>",
  );
  await server.scan(token, library.id, "full");
  expect(await server.api(`/items/${item?.id}`, { token })).toMatchObject({
    item: { title: "Changed local title", overview: "New synopsis" },
  });
  const search = await server.api<{ items: Item[] }>("/search?q=Changed", { token });
  expect(search.items.map((item) => item.id)).toContain(item?.id);
});

for (const [from, to, end, edited] of [
  ["S01E01", "S01E03", null, false],
  ["S01E01", "S01E01-E02", 2, false],
  ["S01E01-E02", "S01E01", null, false],
  ["S01E01", "S01E03", null, true],
] as const)
  test(`renumber ${from} to ${to} drops obsolete provider fields while preserving local edits=${edited}`, async ({
    server,
    admin,
  }) => {
    const token = admin.accessToken;
    const path = `Show/Season 1/Show ${from}.mp4`;
    const library = await server.library(token, "shows", [path]);
    const db = openDatabase(server.databasePath);
    try {
      const id = db.prepare("SELECT id FROM catalog_items WHERE kind = 'episode'").get()
        ?.id as string;
      db.prepare(
        "UPDATE catalog_items SET title='Provider title', overview='Obsolete', year=2020, metadata_state='tmdb' WHERE id=?",
      ).run(id);
      const sources = Object.fromEntries(
        [
          "title",
          "overview",
          "year",
          "releaseDate",
          "contentRating",
          "communityRating",
          "genres",
          "studios",
          "tags",
        ].map((key) => [key, "tmdb"]),
      );
      db.prepare(
        "INSERT INTO catalog_item_metadata(item_id, release_date, content_rating, community_rating, genres_json, studios_json, tags_json, external_ids_json, field_sources_json, locked_fields_json) VALUES (?, '2020-01-01', 'PG', 8, '[\"Drama\"]', '[\"Studio\"]', '[\"Old\"]', '{\"tmdb\":\"1:1:1\",\"imdb\":\"tt1\"}', ?, '[]') ON CONFLICT(item_id) DO UPDATE SET field_sources_json=excluded.field_sources_json, external_ids_json=excluded.external_ids_json, release_date=excluded.release_date, genres_json=excluded.genres_json, studios_json=excluded.studios_json, tags_json=excluded.tags_json, content_rating=excluded.content_rating, community_rating=excluded.community_rating",
      ).run(id, JSON.stringify(sources));
      if (edited)
        await server.api(`/items/${id}/metadata`, {
          token,
          method: "PATCH",
          body: {
            title: "My title",
            releaseDate: "1999-01-01",
            genres: ["My genre"],
            studios: ["My studio"],
            tags: ["My tag"],
            contentRating: "G",
            communityRating: 9,
            overview: "Mine",
            year: 1999,
          },
        });
      await server.scan(token, library.id, "full");
      expect((await server.api<{ item: Item }>(`/items/${id}`, { token })).item.title).toBe(
        edited ? "My title" : "Provider title",
      );
      await rename(join(library.path, path), join(library.path, `Show/Season 1/Show ${to}.mp4`));
      await server.scan(token, library.id, "full");
      const details = await server.api<{
        item: Item & { overview: string | null; year: number | null };
      }>(`/items/${id}`, { token });
      expect(details.item).toMatchObject({
        id,
        indexNumberEnd: end,
        title: edited ? "My title" : to === "S01E03" ? "Episode 3" : "Episode 1",
        overview: edited ? "Mine" : null,
        year: edited ? 1999 : null,
      });
      const metadata = db.prepare("SELECT * FROM catalog_item_metadata WHERE item_id=?").get(id);
      expect(JSON.parse(metadata?.external_ids_json as string)).toEqual({ imdb: "tt1" });
      expect(metadata?.release_date).toBe(edited ? "1999-01-01" : null);
      expect(JSON.parse(metadata?.genres_json as string)).toEqual(edited ? ["My genre"] : []);
      expect(JSON.parse(metadata?.studios_json as string)).toEqual(edited ? ["My studio"] : []);
      expect(JSON.parse(metadata?.tags_json as string)).toEqual(edited ? ["My tag"] : []);
    } finally {
      db.close();
    }
  });
