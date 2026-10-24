import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, password, test } from "./support/server";

test("administrators list and revoke individual devices and sessions without affecting other logins", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const user = await server.api<{ id: string }>("/users", {
    token,
    body: { username: "viewer", displayName: "Viewer", password },
  });
  const first = await server.login("viewer");
  const second = await server.login("viewer");
  const devices = await server.api<{ id: string; userId: string; platform: string }[]>(
    `/users/${user.id}/devices`,
    { token },
  );
  expect(devices).toHaveLength(2);
  expect(
    devices.every((device) => device.userId === user.id && device.platform === "desktop"),
  ).toBe(true);
  const sessions = await server.api<{ id: string; deviceId: string }[]>(
    `/users/${user.id}/sessions`,
    { token },
  );
  expect(sessions.map((session) => session.id).sort()).toEqual(
    [first.sessionId, second.sessionId].sort(),
  );
  for (const path of [`/users/${user.id}/devices`, `/users/${user.id}/sessions`])
    await server.api(path, { token: first.accessToken, status: 403 });
  const device = sessions.find((session) => session.id === first.sessionId)?.deviceId;
  await server.api(`/devices/${device}`, { token, method: "DELETE" });
  await server.api("/auth/me", { token: first.accessToken, status: 401 });
  await server.api("/auth/me", { token: second.accessToken });
  await server.api(`/auth/sessions/${second.sessionId}`, { token, method: "DELETE" });
  await server.api("/auth/me", { token: second.accessToken, status: 401 });
  await server.api(`/users/${user.id}`, {
    token,
    method: "PATCH",
    body: { displayName: "Renamed", isActive: false },
  });
  await server.api("/auth/login", {
    status: 401,
    body: {
      username: "viewer",
      password,
      deviceId: crypto.randomUUID(),
      deviceName: "Third",
      platform: "desktop",
      platformDeviceId: null,
    },
  });
  expect(await server.api("/users", { token })).toContainEqual(
    expect.objectContaining({ id: user.id, displayName: "Renamed", isActive: false }),
  );
});

test("library edits are atomic, overlapping or unavailable roots fail, and indexed libraries cannot change type", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", []);
  expect(
    await server.api(`/libraries/${library.id}`, {
      token,
      method: "PATCH",
      body: { kind: "shows", name: " Series ", slug: "series" },
    }),
  ).toMatchObject({ kind: "shows", name: "Series" });
  await server.media(library.path, "Show/Season 1/Show S01E01.mp4");
  await server.scan(token, library.id);
  await server.api(`/libraries/${library.id}`, {
    token,
    method: "PATCH",
    status: 409,
    body: { kind: "music", name: "Must roll back" },
  });
  expect(await server.api("/admin/libraries", { token })).toContainEqual(
    expect.objectContaining({ id: library.id, name: "Series", kind: "shows" }),
  );
  const nested = join(library.path, "nested");
  await mkdir(nested);
  for (const path of [
    library.path,
    nested,
    join(library.path, "missing"),
    join(library.path, "Show/Season 1/Show S01E01.mp4"),
  ])
    await server.api(`/libraries/${library.id}/roots`, {
      token,
      status: 409,
      body: { id: crypto.randomUUID(), libraryId: library.id, path, priority: 0 },
    });
  await server.api(`/libraries/${library.id}`, {
    token,
    method: "PATCH",
    body: { isEnabled: false },
  });
  await server.api("/scans", { token, status: 409, body: { libraryId: library.id, mode: "full" } });
  await server.api(`/libraries/${library.id}`, {
    token,
    method: "PATCH",
    body: { isEnabled: true },
  });
  await server.scan(token, library.id);
  expect(await server.api(`/libraries/${library.id}/roots`, { token })).toHaveLength(1);
});

test("event streams replay only public and caller events after the requested cursor and release disconnected requests", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const db = new DatabaseSync(server.databasePath);
  const insert = db.prepare(
    "INSERT INTO server_event_log(created_at_ms, topic, user_id, payload_json) VALUES (?, ?, ?, ?)",
  );
  const initial = Number(
    insert.run(Date.now(), "catalog.changed", null, '{"order":1}').lastInsertRowid,
  );
  insert.run(Date.now(), "private.changed", crypto.randomUUID(), '{"secret":true}');
  const final = Number(
    insert.run(Date.now(), "session.changed", admin.userId, '{"order":2}').lastInsertRowid,
  );
  db.close();
  const controller = new AbortController();
  try {
    const response = await server.request(`/api/v1/events?after=${initial}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No SSE stream");
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`id: ${final}\nevent: session.changed\ndata: {"order":2}`);
    expect(chunk).not.toContain("secret");
    expect(chunk).not.toContain('"order":1');
    await reader.cancel();
  } finally {
    controller.abort();
  }
  await server.api("/events?after=-1", { token, status: 400 });
  expect((await server.request("/health/ready")).status).toBe(200);
});
