import { rename, rm, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Item, test } from "./support/server";

test("real scans discover, skip, re-probe, move and delete files without losing watch state", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Arrival (2016).MKV", "Heat (1995).mp4"]);
  const first = await server.items(token, library.id);
  expect(first.map((item) => item.title).sort()).toEqual(["Arrival", "Heat"]);
  const arrival = first.find((item) => item.title === "Arrival");
  expect(arrival).toBeDefined();
  await server.api(`/items/${arrival?.id}/watch-state`, {
    token,
    method: "PUT",
    body: { positionSeconds: 7, completed: false },
  });
  expect(await server.scan(token, library.id)).toMatchObject({
    stats: { discovered: 2, unchanged: 2, skipped: 2, probesEnqueued: 0 },
  });
  await rename(
    join(library.path, "Arrival (2016).MKV"),
    join(library.path, "Arrival renamed (2016).MKV"),
  );
  expect(await server.scan(token, library.id)).toMatchObject({
    stats: { moved: 1, missing: 0, probesEnqueued: 0 },
  });
  expect(await server.api(`/items/${arrival?.id}`, { token })).toMatchObject({
    watchState: { positionSeconds: 7 },
  });
  await utimes(join(library.path, "Heat (1995).mp4"), new Date(1_000_000), new Date(1_000_000));
  expect(await server.scan(token, library.id)).toMatchObject({
    stats: { changed: 1, probesEnqueued: 1 },
  });
  await server.media(library.path, "replacement.tmp");
  await rename(join(library.path, "replacement.tmp"), join(library.path, "Heat (1995).mp4"));
  expect(await server.scan(token, library.id)).toMatchObject({
    stats: { changed: 1, probesEnqueued: 1 },
  });
  await symlink(join(library.path, "Heat (1995).mp4"), join(library.path, "Forbidden.mp4"));
  expect(await server.scan(token, library.id, "full")).toMatchObject({
    stats: { discovered: 2, probesEnqueued: 2 },
  });
  await rm(join(library.path, "Heat (1995).mp4"));
  expect(await server.scan(token, library.id)).toMatchObject({ stats: { missing: 1 } });
  expect(await server.scan(token, library.id)).toMatchObject({ stats: { missing: 0 } });
  expect(await server.items(token, library.id)).toHaveLength(1);
  await server.api(`/libraries/${library.id}`, { token, method: "DELETE" });
  expect(await server.api("/libraries", { token })).toEqual([]);
  await server.api(`/items/${arrival?.id}`, { token, status: 404 });
  const results = await server.api<{ items: Item[] }>("/search?q=Arrival", { token });
  expect(results.items).toEqual([]);
});

test("episode ranges, seasons, next-up and manual watch state survive a full rescan and restart", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "shows", [
    "Serial (2021)/Season 1/Serial S01E01 - Pilot.mp4",
    "Serial (2021)/Season 1/Serial S01E02-E03 - Together.mp4",
    "Serial (2021)/Season 1/Serial S01E03 - Overlap.mp4",
    "Serial (2021)/Season 2/Serial S02E01 - Return.mp4",
  ]);
  const shows = await server.items(token, library.id);
  expect(shows).toHaveLength(1);
  const show = shows[0];
  expect(show).toMatchObject({ title: "Serial", kind: "show" });
  const seasons = (await server.api<{ items: Item[] }>(`/items/${show?.id}/children`, { token }))
    .items;
  expect(seasons.map((item) => item.indexNumber)).toEqual([1, 2]);
  const episodes = (
    await Promise.all(
      seasons.map(
        async (season) =>
          (
            await server.api<{ items: Item[] }>(`/items/${season.id}/children`, { token })
          ).items,
      ),
    )
  ).flat();
  expect(episodes.map((item) => [item.indexNumber, item.indexNumberEnd])).toEqual([
    [1, null],
    [2, 3],
    [3, null],
    [1, null],
  ]);
  const [pilot, combined, overlap, after] = episodes;
  const next = () => server.api(`/items/${show?.id}/next-up`, { token });
  expect(await next()).toMatchObject({ item: { id: pilot?.id } });
  const mark = (item: Item | undefined) =>
    server.api(`/items/${item?.id}/watch-state`, {
      token,
      method: "PUT",
      body: { positionSeconds: 0, completed: true },
    });
  await mark(pilot);
  expect(await next()).toMatchObject({ item: { id: combined?.id } });
  expect(await server.api(`/items/${combined?.id}/adjacent-episodes`, { token })).toMatchObject({
    previous: { id: pilot?.id },
    next: { id: after?.id },
  });
  expect(await server.api(`/items/${after?.id}/adjacent-episodes`, { token })).toMatchObject({
    previous: { id: overlap?.id },
    next: null,
  });
  await mark(combined);
  expect(await next()).toMatchObject({ item: { id: after?.id } });
  expect(await server.api("/home", { token })).toMatchObject({
    nextUp: [expect.objectContaining({ id: after?.id })],
  });
  await server.scan(token, library.id, "full");
  await server.restart();
  expect(await next()).toMatchObject({ item: { id: after?.id } });
  await mark(seasons[1]);
  expect(await server.api(`/items/${after?.id}`, { token })).toMatchObject({
    watchState: { completed: true, positionSeconds: 0 },
  });
});
