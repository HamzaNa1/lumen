import { readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, password, repository, test } from "./support/server";

interface Ticket {
  downloadId: string;
  itemId: string;
  streamPath: string;
  grantToken: string;
  revision: string;
  sizeBytes: number;
  mimeType: string;
  media: { revision?: string; sizeBytes: number | null };
  expiresAtMs: number;
}
interface SyncResult {
  downloadId: string;
  status: "valid" | "changed" | "revoked";
  revision: string | null;
  completed: boolean;
}

const day = 24 * 3_600_000;

test("download grants fetch exact original bytes independently of playback sessions and renew on sync", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  // Sign-in sessions last ten days and renew with use, so time passes in steps the way it would
  // for a device that keeps using the server.
  const advanceDays = async (days: number) => {
    for (let remaining = days; remaining > 0; remaining -= 5) {
      await server.advanceTime(Math.min(5, remaining) * day);
      await server.api("/auth/me", { token });
    }
  };
  expect(
    (await server.api<{ capabilities: Record<string, boolean> }>("/server")).capabilities,
  ).toMatchObject({ downloads: true });
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const [item] = await server.items(token, library.id);
  const ticket = await server.api<Ticket>("/downloads", { token, body: { itemId: item?.id } });
  const bytes = await readFile(join(repository, "tests/fixtures/playback.mp4"));
  expect(ticket).toMatchObject({
    itemId: item?.id,
    sizeBytes: bytes.length,
    mimeType: "video/mp4",
    media: { revision: ticket.revision, sizeBytes: bytes.length },
  });
  const headers = { authorization: `Bearer ${ticket.grantToken}` };
  const full = await server.request(ticket.streamPath, { headers });
  expect(full.status).toBe(200);
  expect(full.headers.get("etag")).toBe(ticket.revision);
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  const part = await server.request(ticket.streamPath, {
    headers: { ...headers, range: "bytes=10-19" },
  });
  expect(part.status).toBe(206);
  expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(10, 20));
  expect(
    (await server.request(`${ticket.streamPath}?transcode=1`, { headers })).status,
    "downloads never convert",
  ).toBe(400);
  // A playback session's grant lapses after an hour without heartbeats; a download's does not.
  const playback = await server.play(token, item?.id ?? "");
  await server.advanceTime(2 * 3_600_000);
  expect(
    (
      await server.request(playback.streamUrl, {
        headers: { authorization: `Bearer ${playback.grantToken}` },
      })
    ).status,
  ).toBe(404);
  expect((await server.request(ticket.streamPath, { headers })).status).toBe(200);
  // Asking again keeps the download and replaces its token.
  const again = await server.api<Ticket>("/downloads", { token, body: { itemId: item?.id } });
  expect(again.downloadId).toBe(ticket.downloadId);
  expect((await server.request(ticket.streamPath, { headers })).status).toBe(404);
  const current = { authorization: `Bearer ${again.grantToken}` };
  // Checking in renews a grant that would otherwise lapse after 30 days.
  await advanceDays(20);
  const synced = await server.api<{ downloads: SyncResult[] }>("/downloads/sync", {
    token,
    status: 200,
    body: { downloads: [{ downloadId: again.downloadId, revision: again.revision }] },
  });
  expect(synced.downloads).toEqual([
    expect.objectContaining({ status: "valid", revision: again.revision, completed: false }),
  ]);
  await advanceDays(20);
  expect((await server.request(again.streamPath, { headers: current })).status).toBe(200);
  await advanceDays(11);
  expect((await server.request(again.streamPath, { headers: current })).status).toBe(404);
  expect(
    (
      await server.api<{ downloads: SyncResult[] }>("/downloads/sync", {
        token,
        status: 200,
        body: { downloads: [{ downloadId: again.downloadId, revision: again.revision }] },
      })
    ).downloads,
  ).toEqual([expect.objectContaining({ status: "revoked" })]);
});

test("changed files, revoked downloads, devices, permissions and library access withdraw download grants", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4", "Other.mp4"]);
  const items = await server.items(token, library.id);
  const film = items.find((item) => item.title === "Film");
  const other = items.find((item) => item.title === "Other");
  const viewer = await server.api<{ id: string; canDownload: boolean }>("/users", {
    token,
    body: {
      username: "viewer",
      displayName: "Viewer",
      password,
      libraryAccess: { scope: "selected", libraryIds: [library.id] },
    },
  });
  expect(viewer.canDownload).toBe(true);
  const login = await server.login("viewer");
  expect(await server.api("/auth/me", { token: login.accessToken })).toMatchObject({
    canDownload: true,
  });
  const issue = (itemId: string | undefined) =>
    server.api<Ticket>("/downloads", { token: login.accessToken, body: { itemId } });
  const sync = async (tickets: Ticket[], accessToken = login.accessToken) =>
    (
      await server.api<{ downloads: SyncResult[] }>("/downloads/sync", {
        token: accessToken,
        status: 200,
        body: {
          downloads: tickets.map(({ downloadId, revision }) => ({ downloadId, revision })),
        },
      })
    ).downloads;
  const fetchStatus = async (ticket: Ticket) =>
    (
      await server.request(ticket.streamPath, {
        headers: { authorization: `Bearer ${ticket.grantToken}` },
      })
    ).status;

  // The file changes on disk: the download is still allowed, under a new revision.
  const filmTicket = await issue(film?.id);
  const later = new Date(Date.now() + 60_000);
  await utimes(join(library.path, "Film.mp4"), later, later);
  await server.scan(token, library.id);
  const [changed] = await sync([filmTicket]);
  expect(changed).toMatchObject({ status: "changed" });
  expect(changed?.revision).not.toBe(filmTicket.revision);
  expect(await fetchStatus(filmTicket)).toBe(200);

  // Another device of the same user cannot see or renew this device's downloads.
  const elsewhere = await server.login("viewer");
  expect(await sync([filmTicket], elsewhere.accessToken)).toEqual([
    expect.objectContaining({ status: "revoked" }),
  ]);

  // Removing a download withdraws it at once.
  await server.api(`/downloads/${filmTicket.downloadId}`, {
    token: login.accessToken,
    method: "DELETE",
  });
  expect(await fetchStatus(filmTicket)).toBe(404);
  expect(await sync([filmTicket])).toEqual([expect.objectContaining({ status: "revoked" })]);

  // Turning downloads off stops transfers in progress and refuses new downloads.
  const otherTicket = await issue(other?.id);
  expect(await fetchStatus(otherTicket)).toBe(200);
  await server.api(`/users/${viewer.id}`, {
    token,
    method: "PATCH",
    status: 200,
    body: { canDownload: false },
  });
  expect(await fetchStatus(otherTicket)).toBe(404);
  await server.api("/downloads", {
    token: login.accessToken,
    body: { itemId: other?.id },
    status: 403,
  });
  expect(await sync([otherTicket])).toEqual([expect.objectContaining({ status: "revoked" })]);
  expect(await server.api("/users", { token })).toContainEqual(
    expect.objectContaining({ id: viewer.id, canDownload: false }),
  );

  // Losing the library takes its downloads with it, even with downloads allowed again.
  await server.api(`/users/${viewer.id}`, {
    token,
    method: "PATCH",
    status: 200,
    body: { canDownload: true },
  });
  const restored = await issue(other?.id);
  expect(await fetchStatus(restored)).toBe(200);
  await server.api(`/users/${viewer.id}`, {
    token,
    method: "PATCH",
    status: 200,
    body: { libraryAccess: { scope: "selected", libraryIds: [] } },
  });
  expect(await fetchStatus(restored)).toBe(404);
  expect(await sync([restored])).toEqual([expect.objectContaining({ status: "revoked" })]);

  // A revoked device loses its downloads; the same user's other devices keep theirs.
  await server.api(`/users/${viewer.id}`, {
    token,
    method: "PATCH",
    status: 200,
    body: { libraryAccess: { scope: "all" } },
  });
  const kept = await server.api<Ticket>("/downloads", {
    token: elsewhere.accessToken,
    body: { itemId: other?.id },
  });
  const lost = await issue(other?.id);
  expect(await fetchStatus(lost)).toBe(200);
  const sessions = await server.api<{ id: string; deviceId: string }[]>(
    `/users/${viewer.id}/sessions`,
    { token },
  );
  const device = sessions.find((session) => session.id === login.sessionId)?.deviceId;
  await server.api(`/devices/${device}`, { token, method: "DELETE" });
  expect(await fetchStatus(lost)).toBe(404);
  expect(await fetchStatus(kept)).toBe(200);
});

test("offline watch progress applies only over older state and reaches download sync", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const [item] = await server.items(token, library.id);
  const ticket = await server.api<Ticket>("/downloads", { token, body: { itemId: item?.id } });
  const watchState = async () =>
    (
      await server.api<{ watchState: { positionSeconds: number; completed: boolean } | null }>(
        `/items/${item?.id}`,
        { token },
      )
    ).watchState;
  const put = (body: unknown) =>
    server.api(`/items/${item?.id}/watch-state`, { token, method: "PUT", status: 200, body });
  const seenAt = Date.now();
  await put({ positionSeconds: 12, completed: false });
  // Progress a device saw before the latest change loses to it.
  await put({ positionSeconds: 3, completed: false, observedAtMs: seenAt - 60_000 });
  expect(await watchState()).toMatchObject({ positionSeconds: 12, completed: false });
  await server.advanceTime(60_000);
  await put({ positionSeconds: 20, completed: true, observedAtMs: Date.now() + 30_000 });
  expect(await watchState()).toMatchObject({ positionSeconds: 20, completed: true });
  const [synced] = (
    await server.api<{ downloads: SyncResult[] }>("/downloads/sync", {
      token,
      status: 200,
      body: { downloads: [{ downloadId: ticket.downloadId, revision: ticket.revision }] },
    })
  ).downloads;
  expect(synced).toMatchObject({ status: "valid", completed: true });
});
