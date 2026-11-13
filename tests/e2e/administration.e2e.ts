import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { openDatabase } from "./support/database";
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

test("administrators browse readable server folders, create a library with its folder in one step, and replace a folder atomically", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const base = join(server.root, "browse");
  await server.media(base, "Movies/Loose.mp4");
  await server.media(base, "Movies/Film (2020)/Film.mp4");
  await writeFile(join(base, "Movies/notes.txt"), "not media");
  await mkdir(join(base, "Shows"));
  await mkdir(join(base, ".hidden"));
  await mkdir(join(base, "locked"));
  await chmod(join(base, "locked"), 0o000);
  const canonical = await realpath(base);
  type Listing = {
    path: string;
    home: string;
    parent: string | null;
    trail: { name: string; path: string }[];
    directories: { name: string; path: string }[];
    files: { name: string; size: number; kind: string }[];
    truncated: boolean;
    overlaps: { rootId: string; libraryId: string; libraryName: string } | null;
  };
  const list = (path: string | null, status = 200, as = token) =>
    server.api<Listing>(
      `/admin/directories${path === null ? "" : `?path=${encodeURIComponent(path)}`}`,
      { token: as, status },
    );
  try {
    const top = await list(base);
    expect(top).toMatchObject({
      path: canonical,
      parent: dirname(canonical),
      directories: [
        { name: "Movies", path: join(canonical, "Movies") },
        { name: "Shows", path: join(canonical, "Shows") },
      ],
      files: [],
      truncated: false,
      overlaps: null,
    });
    expect(top.trail.at(-1)).toEqual({ name: "browse", path: canonical });
    expect(top.trail[0]?.path).toBe(parse(canonical).root);
    expect((await list(join(base, "Movies"))).files).toEqual([
      { name: "Loose.mp4", size: expect.any(Number), kind: "video" },
    ]);
    const home = await list(null);
    expect(home.path).toBe(home.home);
    await list("relative/path", 400);
    await list(join(base, "missing"), 404);
    await list(join(base, "locked"), 409);
    await server.api("/users", {
      token,
      body: { username: "viewer", displayName: "Viewer", password },
    });
    await list(base, 403, (await server.login("viewer")).accessToken);

    const library = { id: crypto.randomUUID(), name: "Movies", slug: "movies", kind: "movies" };
    const rootId = crypto.randomUUID();
    await server.api("/libraries", {
      token,
      body: { ...library, root: { id: rootId, path: join(base, "Movies") } },
    });
    expect(await server.api(`/libraries/${library.id}/roots`, { token })).toMatchObject([
      { id: rootId, path: join(canonical, "Movies") },
    ]);
    expect((await list(base)).overlaps).toEqual({
      rootId,
      libraryId: library.id,
      libraryName: "Movies",
    });
    const overlapping = crypto.randomUUID();
    await server.api("/libraries", {
      token,
      status: 409,
      body: {
        id: overlapping,
        name: "Everything",
        slug: "everything",
        root: { id: crypto.randomUUID(), path: base },
      },
    });
    expect(await server.api<{ id: string }[]>("/admin/libraries", { token })).not.toContainEqual(
      expect.objectContaining({ id: overlapping }),
    );

    await server.scan(token, library.id);
    expect(await server.items(token, library.id)).toHaveLength(2);
    const other = await server.library(token, "shows", []);
    const replacement = crypto.randomUUID();
    await server.api(`/libraries/${library.id}/roots`, {
      token,
      status: 404,
      body: {
        id: replacement,
        libraryId: library.id,
        path: join(base, "Shows"),
        priority: 0,
        replacesRootId: other.rootId,
      },
    });
    await server.api(`/libraries/${library.id}/roots`, {
      token,
      body: {
        id: replacement,
        libraryId: library.id,
        path: join(base, "Movies/Film (2020)"),
        priority: 0,
        replacesRootId: rootId,
      },
    });
    expect(await server.api(`/libraries/${library.id}/roots`, { token })).toMatchObject([
      { id: replacement, path: join(canonical, "Movies/Film (2020)") },
    ]);
    expect(await server.items(token, library.id)).toHaveLength(0);
    await server.scan(token, library.id);
    expect(await server.items(token, library.id)).toHaveLength(1);
  } finally {
    await chmod(join(base, "locked"), 0o755);
  }
});

test("event streams replay only public and caller events after the requested cursor and release disconnected requests", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const db = openDatabase(server.databasePath);
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
