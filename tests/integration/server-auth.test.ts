import { afterEach, describe, expect, test } from "bun:test";
import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

const runningServers: RunningServer[] = [];
const paths: string[] = [];

const seedAdmin = async (databasePath: string): Promise<void> => {
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer));
  await Effect.runPromise(Effect.gen(function* () {
    const database = yield* Database;
    const result = yield* database.run(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${newUuid()}, 'admin', 'admin', 'Admin', ${yield* Effect.promise(() => hashPassword("correct horse battery staple"))}, 'admin', 1, unixepoch() * 1000, unixepoch() * 1000)
    `);
    void result;
  }).pipe(Effect.provide(layer)));
};

const start = async (databasePath: string): Promise<URL> => {
  const running = await startServer({ databasePath, host: "127.0.0.1", port: 0 });
  runningServers.push(running);
  return new URL(running.server.url);
};

const request = async (base: URL, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(new URL(path, base), init);

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("server authentication and ACL", () => {
  test("refreshes an expired access session and accepts the rotated access token", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-refresh-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    await seedAdmin(databasePath);
    const base = await start(databasePath);
    const login = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple", deviceId: newUuid(), deviceName: "Test", platform: "desktop", platformDeviceId: null }),
    });
    expect(login.status).toBe(200);
    const first = await login.json() as { sessionId: string; accessToken: string; refreshToken: string };
    const databaseLayer = makeDatabaseLayers({ databasePath } as never);
    await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      yield* database.run(sql`UPDATE auth_sessions SET issued_at_ms = 1, last_used_at_ms = 1, expires_at_ms = 2 WHERE id = ${first.sessionId}`);
    }).pipe(Effect.provide(databaseLayer)));
    expect((await request(base, "/api/v1/auth/me", { headers: { authorization: `Bearer ${first.accessToken}` } })).status).toBe(401);
    const refreshed = await request(base, "/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const second = await refreshed.json() as { accessToken: string; refreshToken: string };
    expect((await request(base, "/api/v1/auth/me", { headers: { authorization: `Bearer ${second.accessToken}` } })).status).toBe(200);
    expect((await request(base, "/api/v1/auth/me", { headers: { authorization: `Bearer ${first.accessToken}` } })).status).toBe(401);
    const next = await request(base, "/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: second.refreshToken }),
    });
    expect(next.status).toBe(200);
  });

  test("lets the first account register as the administrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-setup-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    const base = await start(databasePath);
    expect((await request(base, "/api/v1/auth/setup")).status).toBe(200);
    expect((await (await request(base, "/api/v1/auth/setup")).json() as { setupRequired: boolean }).setupRequired).toBe(true);
    const registration = await request(base, "/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", displayName: "Owner", password: "correct horse battery staple", deviceId: newUuid(), deviceName: "Setup", platform: "web", platformDeviceId: null }),
    });
    expect(registration.status).toBe(201);
    expect((await registration.json() as { role: string }).role).toBe("admin");
    expect((await (await request(base, "/api/v1/auth/setup")).json() as { setupRequired: boolean }).setupRequired).toBe(false);
    const second = await request(base, "/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "second", displayName: "Second", password: "correct horse battery staple", deviceId: newUuid(), deviceName: "Setup", platform: "web", platformDeviceId: null }),
    });
    expect(second.status).toBe(409);
  });

  test("hashes credentials, enforces bearer auth, and scopes library browsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    await seedAdmin(databasePath);
    const base = await start(databasePath);
    const login = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple", deviceId: newUuid(), deviceName: "Test", platform: "web", platformDeviceId: null }),
    });
    expect(login.status).toBe(200);
    const admin = await login.json() as { accessToken: string };
    expect(admin.accessToken).toBeString();
    expect((await request(base, "/api/v1/auth/me")).status).toBe(401);
    const me = await request(base, "/api/v1/auth/me", { headers: { authorization: `Bearer ${admin.accessToken}` } });
    expect(me.status).toBe(200);
    expect((await me.json() as { role: string }).role).toBe("admin");

    const userResponse = await request(base, "/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ username: "listener", displayName: "Listener", password: "listener password 123" }),
    });
    expect(userResponse.status).toBe(201);
    const user = await userResponse.json() as { id: string };
    const libraryResponse = await request(base, "/api/v1/libraries", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ id: newUuid(), name: "Music", slug: "music" }),
    });
    expect(libraryResponse.status).toBe(201);
    const library = await libraryResponse.json() as { id: string };
    const managedLibraries = await request(base, "/api/v1/admin/libraries", { headers: { authorization: `Bearer ${admin.accessToken}` } });
    expect(managedLibraries.status).toBe(200);
    expect((await managedLibraries.json() as ReadonlyArray<{ id: string }>).some((value) => value.id === library.id)).toBe(true);
    const updateLibrary = await request(base, `/api/v1/libraries/${library.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ name: "Music Updated", kind: "music", isEnabled: true }),
    });
    expect(updateLibrary.status).toBe(200);
    expect((await updateLibrary.json() as { name: string }).name).toBe("Music Updated");
    const mediaRoot = join(root, "media");
    await Bun.write(join(root, ".keep"), "");
    await mkdir(mediaRoot);
    const rootResponse = await request(base, `/api/v1/libraries/${library.id}/roots`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ id: newUuid(), libraryId: library.id, path: mediaRoot, priority: 0 }),
    });
    expect(rootResponse.status).toBe(201);
    const userLogin = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "listener", password: "listener password 123", deviceId: newUuid(), deviceName: "Listener", platform: "web", platformDeviceId: null }),
    });
    expect(userLogin.status).toBe(200);
    const listener = await userLogin.json() as { accessToken: string };
    const noGrant = await request(base, `/api/v1/tracks?libraryId=${library.id}`, { headers: { authorization: `Bearer ${listener.accessToken}` } });
    expect(noGrant.status).toBe(403);
    const grant = await request(base, `/api/v1/libraries/${library.id}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ id: newUuid(), libraryId: library.id, userId: user.id, role: "user", capabilities: ["library:read"], canDownload: false, expiresAtMs: null }),
    });
    expect(grant.status).toBe(200);
    const empty = await request(base, `/api/v1/tracks?libraryId=${library.id}`, { headers: { authorization: `Bearer ${listener.accessToken}` } });
    expect(empty.status).toBe(200);
    expect((await empty.json() as { items: unknown[] }).items).toEqual([]);
  });
});
