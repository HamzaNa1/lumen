import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Item, password, repository, test } from "./support/server";

interface Home {
  libraries: { id: string }[];
  latest: { libraryId: string; items: Item[] }[];
  continueWatching: Item[];
  continueListening: Item[];
  nextUp: Item[];
}

test("Home orders and limits the complete catalog after access and availability filtering, and watch marks clear resume", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const movies = await server.library(
    token,
    "movies",
    Array.from({ length: 65 }, (_, index) => `Film ${String(index).padStart(2, "0")}.mp4`),
  );
  const other = await server.library(token, "movies", ["Private.mp4"]);
  const items = await server.items(token, movies.id);
  expect(items).toHaveLength(65);
  const viewer = await server.api<{ id: string }>("/users", {
    token,
    body: {
      username: "viewer",
      displayName: "Viewer",
      password,
      libraryAccess: { scope: "selected", libraryIds: [movies.id] },
    },
  });
  const account = await server.login("viewer");
  const db = new DatabaseSync(server.databasePath);
  try {
    // Fix externally visible chronology without sleeping between 65 independent scans.
    for (const [index, item] of items.entries())
      db.prepare("UPDATE catalog_items SET added_at_ms = ?, updated_at_ms = ? WHERE id = ?").run(
        index + 1,
        index + 1,
        item.id,
      );
    for (const item of items.slice(-14))
      await server.api(`/items/${item.id}/watch-state`, {
        token: account.accessToken,
        method: "PUT",
        body: { positionSeconds: 5, completed: false },
      });
    for (const [index, item] of items.entries())
      db.prepare("UPDATE item_watch_states SET updated_at_ms = ? WHERE item_id = ?").run(
        index + 1,
        item.id,
      );
    const home = await server.api<Home>("/home", { token: account.accessToken });
    expect(home.libraries.map((library) => library.id)).toEqual([movies.id]);
    expect(home.continueWatching).toHaveLength(12);
    expect(home.continueWatching.map((item) => item.id)).toEqual(
      items
        .slice(-12)
        .reverse()
        .map((item) => item.id),
    );
    expect(home.latest[0]?.items).toHaveLength(16);
    expect(home.latest[0]?.items[0]?.id).toBe(items.at(-1)?.id);
    expect(home.latest.some((row) => row.libraryId === other.id)).toBe(false);
    const last = items.at(-1);
    await server.api(`/items/${last?.id}/watch-state`, {
      token: account.accessToken,
      method: "PUT",
      body: { positionSeconds: 0, completed: true },
    });
    expect(await server.api(`/items/${last?.id}`, { token: account.accessToken })).toMatchObject({
      watchState: { completed: true, positionSeconds: 0 },
    });
    expect(
      (await server.api<Home>("/home", { token: account.accessToken })).latest[0]?.items.map(
        (item) => item.id,
      ),
    ).not.toContain(last?.id);
    await server.api(`/users/${viewer.id}`, {
      token,
      method: "PATCH",
      body: { libraryAccess: { scope: "selected", libraryIds: [] } },
    });
    expect(await server.api("/home", { token: account.accessToken })).toMatchObject({
      libraries: [],
      latest: [],
      continueWatching: [],
      nextUp: [],
    });
    await server.api(`/items/${last?.id}/watch-state`, {
      token: account.accessToken,
      method: "PUT",
      status: 403,
      body: { positionSeconds: 0, completed: false },
    });
  } finally {
    db.close();
  }
});

test("music files are scanned into artists and albums, resumes independently and is pruned from search when removed", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "music", []);
  const albumPath = join(library.path, "E2E Artist", "E2E Album");
  await mkdir(albumPath, { recursive: true });
  for (const [index, title] of ["First Song", "Second Song"].entries())
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        join(repository, "tests/fixtures/playback.mp4"),
        "-vn",
        "-c:a",
        "flac",
        "-metadata",
        `title=${title}`,
        "-metadata",
        "artist=E2E Artist",
        "-metadata",
        "album=E2E Album",
        "-metadata",
        `track=${index + 1}`,
        join(albumPath, `${title}.mkv`),
      ],
      { timeout: 15000 },
    );
  await server.scan(token, library.id);
  const search = await server.api<{ items: Item[] }>("/search?q=Song", { token });
  expect(search.items.map((item) => item.title).sort()).toEqual(["First Song", "Second Song"]);
  const song = search.items[0];
  const playback = await server.play(token, song?.id ?? "");
  expect(
    (
      await server.request(playback.streamUrl, {
        headers: { authorization: `Bearer ${playback.grantToken}`, range: "bytes=0-99" },
      })
    ).status,
  ).toBe(206);
  await server.api(`/playback/sessions/${playback.sessionId}/progress`, {
    token,
    status: 200,
    body: { trackId: song?.id, positionMs: 5000, durationMs: 20000, sequence: 1 },
  });
  expect((await server.api<Home>("/home", { token })).continueListening).toEqual([
    expect.objectContaining({ id: song?.id }),
  ]);
  await server.api(`/items/${song?.id}/watch-state`, {
    token,
    method: "PUT",
    body: { positionSeconds: 0, completed: true },
  });
  const home = await server.api<Home>("/home", { token });
  expect(home.continueListening).toEqual([]);
  expect(home.latest.find((row) => row.libraryId === library.id)?.items.length).toBeGreaterThan(0);
  await server.api(`/playback/sessions/${playback.sessionId}`, { token, method: "DELETE" });
  await rm(join(albumPath, "First Song.mkv"));
  await rm(join(albumPath, "Second Song.mkv"));
  await writeFile(join(library.path, "mounted.txt"), "This root is available");
  await server.scan(token, library.id);
  for (const query of ["Song", "E2E Artist", "E2E Album"])
    expect(
      (await server.api<{ items: Item[] }>(`/search?q=${encodeURIComponent(query)}`, { token }))
        .items,
    ).toEqual([]);
  expect(await server.items(token, library.id)).toEqual([]);
});
