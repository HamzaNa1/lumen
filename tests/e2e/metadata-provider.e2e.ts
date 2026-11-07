import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, utimes } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { openDatabase } from "./support/database";
import { test as base, expect, type Item, password, repository } from "./support/server";

const test = base.extend<{ provider: HttpServer }>({
  provider: async ({ playwright: _playwright }, use) => {
    const provider = createServer();
    try {
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      await use(provider);
    } finally {
      if (provider.listening)
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
    }
  },
  serverEnvironment: async ({ provider }, use) => {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider did not listen");
    await use({ LUMEN_E2E_TMDB_ORIGIN: `http://127.0.0.1:${address.port}` });
  },
});

const groupId = "641eb9d6b234b9007ac67063";

test("provider matching and episode order refresh preserve identity, survive restart and fail without corrupting metadata", async ({
  server,
  admin,
  provider,
}) => {
  const token = admin.accessToken;
  let unavailable = false;
  let missingMapping = false;
  provider.on("request", (request, response) => {
    if (unavailable) {
      response.writeHead(503).end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://provider.test").pathname;
    let body: unknown;
    if (path === "/3/search/tv")
      body = {
        results: [
          { id: 65942, name: "Serial", first_air_date: "2021-01-01", overview: "Provider series" },
        ],
      };
    else if (path === "/3/tv/65942" || path === "/3/tv/123")
      body = { name: "Serial", overview: "Provider series", first_air_date: "2021-01-01" };
    else if (path.endsWith("/episode_groups"))
      body = {
        results: [
          { id: groupId, name: "Production seasons", description: "Production order", type: 6 },
        ],
      };
    else if (path === `/3/tv/episode_group/${groupId}`)
      body = {
        groups: [
          {
            order: 4,
            episodes: missingMapping
              ? []
              : Array.from({ length: 10 }, (_, order) => ({
                  order,
                  season_number: 1,
                  episode_number: 67 + order,
                })),
          },
        ],
      };
    else if (path.includes("/episode/")) {
      const episode = Number(path.split("/").at(-1));
      body = { name: `Episode from provider ${episode}`, overview: `Synopsis ${episode}` };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const library = await server.library(token, "shows", [
    "Serial/Season 4/Serial S04E01.mp4",
    "Serial/Season 4/Serial S04E02-E03.mp4",
  ]);
  const show = (await server.items(token, library.id))[0];
  const seasons = await server.api<{ items: Item[] }>(`/items/${show?.id}/children`, { token });
  const children = () =>
    server.api<{ items: Item[] }>(`/items/${seasons.items[0]?.id}/children`, { token });
  const original = (await children()).items;
  await server.api("/admin/metadata-settings", {
    token,
    method: "PUT",
    body: { tmdbApiKey: "e2e-provider-key" },
  });
  const waitForRun = async (run: { runId: string }, status = "succeeded") => {
    await expect
      .poll(
        async () => (await server.api<{ status: string }>(`/scans/${run.runId}`, { token })).status,
        { timeout: 30000 },
      )
      .toBe(status);
  };
  await expect
    .poll(
      async () =>
        (await server.api<{ status: string }[]>("/admin/jobs", { token })).every(
          (job) => job.status !== "running" && job.status !== "queued",
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  const match = await server.api<{ runId: string }>(`/items/${show?.id}/match`, {
    token,
    method: "PUT",
    body: { tmdbId: "65942" },
  });
  await waitForRun(match);
  const orderPath = `/items/${show?.id}/episode-order`;
  expect(await server.api(orderPath, { token })).toMatchObject({ tmdbSeriesId: "65942" });
  await server.api("/users", {
    token,
    body: {
      username: "viewer",
      displayName: "Viewer",
      password,
      libraryAccess: { scope: "all" },
    },
  });
  const viewer = await server.login("viewer");
  await server.api(orderPath, {
    token: viewer.accessToken,
    method: "PUT",
    status: 403,
    body: { tmdbSeriesId: "65942", groupId },
  });
  await waitForRun(
    await server.api(orderPath, {
      token,
      method: "PUT",
      body: { tmdbSeriesId: "65942", groupId },
    }),
  );
  const mapped = (await children()).items;
  expect(mapped.map((item) => item.id)).toEqual(original.map((item) => item.id));
  expect(mapped[0]?.title).toBe("Episode from provider 67");
  expect(mapped[1]?.title).toContain("Episode from provider 68");
  expect(mapped[1]).toMatchObject({ indexNumber: 2, indexNumberEnd: 3 });
  await server.restart();
  expect(await server.api(orderPath, { token })).toMatchObject({ groupId });
  unavailable = true;
  await server.api(orderPath, { token, status: 503 });
  expect((await children()).items).toEqual(mapped);
  unavailable = false;
  missingMapping = true;
  await waitForRun(
    await server.api(orderPath, {
      token,
      method: "PUT",
      body: { tmdbSeriesId: "65942", groupId },
    }),
    "failed",
  );
  expect((await children()).items).toEqual(mapped);
});

test("movie matching searches and deduplicates candidates, downloads real artwork, preserves edits and sweeps unreferenced files", async ({
  server,
  admin,
  provider,
}) => {
  const token = admin.accessToken;
  const images = new Map<string, Buffer>();
  images.set("poster.png", await readFile(join(repository, "tests/fixtures/still.png")));
  for (const extension of ["jpg"]) {
    const path = join(server.root, `image.${extension}`);
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(repository, "tests/fixtures/still.png"),
      "-frames:v",
      "1",
      path,
    ]);
    images.set(`image.${extension}`, await readFile(path));
  }
  images.set("image.webp", await readFile(join(repository, "tests/fixtures/still.webp")));
  let unavailable = false;
  const movie = {
    id: 42,
    title: "Provider film",
    overview: "Provider synopsis",
    release_date: "2022-02-02",
    vote_average: 8.4,
    poster_path: "/poster.png",
    backdrop_path: "/image.jpg",
    genres: [{ name: "Drama" }],
    production_companies: [{ name: "Studio" }],
    keywords: { keywords: [{ name: "Tag" }] },
    release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG" }] }] },
    external_ids: { imdb_id: "tt42" },
    images: { logos: [{ file_path: "/image.webp" }] },
  };
  provider.on("request", (request, response) => {
    if (unavailable) {
      response.writeHead(503).end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const image = images.get(path.split("/").at(-1) ?? "");
    if (image) {
      response.writeHead(200).end(image);
      return;
    }
    if (path === "/3/movie/42") response.writeHead(200).end(JSON.stringify(movie));
    else if (path === "/3/search/movie")
      response.writeHead(200).end(
        JSON.stringify({
          results: [
            movie,
            movie,
            { id: 43, title: null },
            { id: 44, title: "Another", release_date: null },
          ],
        }),
      );
    else response.writeHead(404).end();
  });
  const library = await server.library(token, "movies", ["Provider film (2022).mp4"]);
  const itemId = (await server.items(token, library.id))[0]?.id ?? "";
  await server.api(`/items/${itemId}/match`, { token, status: 400 });
  await server.api("/admin/metadata-settings", {
    token,
    method: "PUT",
    body: { tmdbApiKey: "fixture-key" },
  });
  const settled = async () =>
    expect
      .poll(
        async () =>
          (await server.api<{ status: string }[]>("/admin/jobs", { token })).every(
            (job) => !["running", "queued"].includes(job.status),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
  await settled();
  const options = await server.api<{
    candidates: { tmdbId: string; posterUrl: string | null }[];
  }>(`/items/${itemId}/match?query=42`, { token });
  expect(options.candidates.map((c) => c.tmdbId)).toEqual(["42", "44"]);
  expect(options.candidates[0]?.posterUrl).toContain("data:image/png;base64,");
  await server.api(`/items/${itemId}/match`, {
    token,
    method: "PUT",
    body: { tmdbId: "999" },
    status: 400,
  });
  await server.api(`/items/${itemId}/match`, { token, method: "PUT", body: { tmdbId: "42" } });
  await settled();
  expect(await server.api(`/items/${itemId}`, { token })).toMatchObject({
    item: { title: "Provider film", overview: "Provider synopsis", year: 2022 },
  });
  expect(
    (await readdir(join(server.root, "artwork"))).map((file) => file.split(".").at(-1)).sort(),
  ).toEqual(["jpg", "png", "webp"]);
  await server.api(`/items/${itemId}/metadata`, {
    token,
    method: "PATCH",
    body: { title: "Mine", overview: "Keep this" },
  });
  await server.api(`/items/${itemId}/refresh`, { token, status: 200, body: {} });
  await settled();
  expect(await server.api(`/items/${itemId}`, { token })).toMatchObject({
    item: { title: "Mine", overview: "Keep this" },
  });
  unavailable = true;
  await server.api(`/items/${itemId}/match?query=42`, { token, status: 503 });
  unavailable = false;
  for (const file of await readdir(join(server.root, "artwork")))
    await utimes(join(server.root, "artwork", file), new Date(0), new Date(0));
  await server.api(`/libraries/${library.id}`, { token, method: "DELETE" });
  await expect
    .poll(async () => readdir(join(server.root, "artwork")), { timeout: 15000 })
    .toEqual([]);
  expect(await server.api("/search?q=Mine", { token })).toMatchObject({ items: [] });
});

// TMDb lists each two-parter once, while the files follow release numbering that splits them.
const tmdbSeason = [
  "Gossip Mill",
  "The Long Night",
  "Mafia Run",
  "The Manager and the Salesman",
  "Whistle Stop",
  "Homecoming (1)",
  "Homecoming (2)",
  "Epilogue",
  "Bonus Night",
  "Last Call",
  "The End",
];
const releasedFiles = [
  // [file, title before TMDb names the season's episodes, title after, confidence after]
  ["S02E01 - Gossip Mill WEBDL-1080p", "Gossip Mill", "Gossip Mill", 95],
  ["S02E02-E03 - The Long Night WEBDL-1080p", "The Long Night / Mafia Run", "The Long Night", 90],
  ["S02E04 - Mafia Run WEBDL-1080p", "The Manager and the Salesman", "Mafia Run", 90],
  ["S02E05 - Manager and Salesman WEBDL-1080p", "Whistle Stop", "The Manager and the Salesman", 90],
  ["S02E06 - Whistle Stop WEBDL-1080p", "Homecoming (1)", "Whistle Stop", 90],
  ["S02E07 - Homecoming WEBDL-1080p", "Homecoming (2)", "Homecoming (1) / Homecoming (2)", 90],
  ["S02E08", "Epilogue", "Epilogue", 95],
  // A title naming no episode falls back to its number, unless another file's title claims it.
  ["S02E09 - Le Retour WEBDL-1080p", "Bonus Night", "Le Retour", null],
  ["S02E10 - Bonus Night WEBDL-1080p", "Last Call", "Bonus Night", 90],
  ["S02E11 - Fin WEBDL-1080p", "The End", "The End", 80],
  ["S02E12 - Encore WEBDL-1080p", "Encore", "Encore", null],
] as const;

test("episodes numbered differently from TMDb match by the title in their file name and refresh away earlier mismatches", async ({
  server,
  admin,
  provider,
}) => {
  const token = admin.accessToken;
  let named = false;
  provider.on("request", (request, response) => {
    const path = new URL(request.url ?? "/", "http://provider.test").pathname;
    const episode = /^\/3\/tv\/77\/season\/2\/episode\/(\d+)$/u.exec(path)?.[1];
    let body: unknown;
    if (path === "/3/search/tv")
      body = { results: [{ id: 77, name: "Paper Town", first_air_date: "2009-09-17" }] };
    else if (path === "/3/tv/77") body = { name: "Paper Town", first_air_date: "2009-09-17" };
    else if (path === "/3/tv/77/season/2")
      body = {
        name: "Season 2",
        episodes: tmdbSeason.map((name, index) => ({
          episode_number: index + 1,
          name: named ? name : null,
        })),
      };
    else if (episode !== undefined && tmdbSeason[Number(episode) - 1] !== undefined)
      body = { name: tmdbSeason[Number(episode) - 1], overview: `Synopsis ${episode}` };
    else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const library = await server.library(
    token,
    "shows",
    releasedFiles.map(([file]) => `Paper Town/Season 2/Paper Town - ${file}.mp4`),
  );
  const show = (await server.items(token, library.id))[0];
  const seasons = await server.api<{ items: Item[] }>(`/items/${show?.id}/children`, { token });
  const episodes = async () =>
    (await server.api<{ items: Item[] }>(`/items/${seasons.items[0]?.id}/children`, { token }))
      .items;
  const settled = async () =>
    expect
      .poll(
        async () =>
          (await server.api<{ status: string }[]>("/admin/jobs", { token })).every(
            (job) => !["running", "queued"].includes(job.status),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
  const original = await episodes();
  expect(original.map((item) => item.title)).toEqual(
    releasedFiles.map(([file]) => file.split(" - ")[1]?.replace(" WEBDL-1080p", "") ?? "Episode 8"),
  );
  await server.api("/admin/metadata-settings", {
    token,
    method: "PUT",
    body: { tmdbApiKey: "e2e-provider-key" },
  });
  await settled();
  // Without episode names to compare, numbers alone place every file, as they did before titles.
  expect((await episodes()).map((item) => item.title)).toEqual(
    releasedFiles.map(([, numbered]) => numbered),
  );
  named = true;
  await server.api(`/items/${show?.id}/refresh`, { token, status: 200, body: {} });
  await settled();
  const matched = await episodes();
  expect(matched.map((item) => item.id)).toEqual(original.map((item) => item.id));
  expect(matched.map((item) => item.title)).toEqual(releasedFiles.map(([, , titled]) => titled));
  expect(matched[1]).toMatchObject({ indexNumber: 2, indexNumberEnd: 3 });
  const db = openDatabase(server.databasePath);
  try {
    const records = matched.map((item) =>
      db
        .prepare("SELECT confidence FROM provider_records WHERE item_id = ? AND provider = 'tmdb'")
        .all(item.id)
        .map((row) => row.confidence),
    );
    expect(records).toEqual(
      releasedFiles.map(([, , , confidence]) => (confidence === null ? [] : [confidence])),
    );
  } finally {
    db.close();
  }
  expect(
    (await server.api<{ status: string }[]>("/admin/jobs", { token })).filter(
      (job) => job.status === "failed",
    ),
  ).toEqual([]);
});
