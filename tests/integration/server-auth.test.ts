import { afterEach, describe, expect, test } from "bun:test";
import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import {
  hashPassword,
  hashToken,
  newOpaqueToken,
  newUuid,
} from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

const runningServers: RunningServer[] = [];
const paths: string[] = [];

const seedAdmin = async (databasePath: string): Promise<void> => {
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer));
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const result = yield* database.run(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${newUuid()}, 'admin', 'admin', 'Admin', ${yield* Effect.promise(() => hashPassword("correct horse battery staple"))}, 'admin', 1, unixepoch() * 1000, unixepoch() * 1000)
    `);
      void result;
    }).pipe(Effect.provide(layer)),
  );
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
  test("validates the session secret and extends an active session", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-refresh-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    await seedAdmin(databasePath);
    const base = await start(databasePath);
    const login = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Test",
        platform: "desktop",
        platformDeviceId: null,
      }),
    });
    expect(login.status).toBe(200);
    const first = (await login.json()) as { sessionId: string; accessToken: string };
    expect(first.accessToken.startsWith(`${first.sessionId}.`)).toBe(true);
    expect(
      (
        await request(base, "/api/v1/auth/me", {
          headers: { authorization: `Bearer ${first.sessionId}.invalid` },
        })
      ).status,
    ).toBe(401);
    const databaseLayer = makeDatabaseLayers({ databasePath } as never);
    const previousVerification = Date.now() - 2 * 60 * 60 * 1000;
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const row = yield* database.get<{ secretHash: string }>(
          sql`SELECT session_token_hash AS secretHash FROM auth_sessions WHERE id = ${first.sessionId}`,
        );
        expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
        expect(first.accessToken.includes(row?.secretHash ?? "")).toBe(false);
        yield* database.run(
          sql`UPDATE auth_sessions SET issued_at_ms = ${previousVerification - 1}, last_used_at_ms = ${previousVerification} WHERE id = ${first.sessionId}`,
        );
      }).pipe(Effect.provide(databaseLayer)),
    );
    expect(
      (
        await request(base, "/api/v1/auth/me", {
          headers: { authorization: `Bearer ${first.accessToken}` },
        })
      ).status,
    ).toBe(200);
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const row = yield* database.get<{ lastVerifiedAtMs: number; expiresAtMs: number }>(sql`
        SELECT last_used_at_ms AS lastVerifiedAtMs, expires_at_ms AS expiresAtMs FROM auth_sessions WHERE id = ${first.sessionId}
      `);
        expect(row?.lastVerifiedAtMs).toBeGreaterThan(previousVerification);
        expect(row?.expiresAtMs).toBeGreaterThan(Date.now() + 9 * 24 * 60 * 60 * 1000);
        yield* database.run(
          sql`UPDATE auth_sessions SET issued_at_ms = 1, last_used_at_ms = 1 WHERE id = ${first.sessionId}`,
        );
      }).pipe(Effect.provide(databaseLayer)),
    );
    expect(
      (
        await request(base, "/api/v1/auth/me", {
          headers: { authorization: `Bearer ${first.accessToken}` },
        })
      ).status,
    ).toBe(401);
  });

  test("lets the first account register as the administrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-setup-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    const base = await start(databasePath);
    const setup = await request(base, "/api/v1/auth/setup");
    expect(setup.status).toBe(200);
    expect(setup.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await (await request(base, "/api/v1/auth/setup")).json()) as { setupRequired: boolean })
        .setupRequired,
    ).toBe(true);
    const registration = await request(base, "/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        displayName: "Owner",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Setup",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(registration.status).toBe(201);
    expect(((await registration.json()) as { role: string }).role).toBe("admin");
    expect(
      ((await (await request(base, "/api/v1/auth/setup")).json()) as { setupRequired: boolean })
        .setupRequired,
    ).toBe(false);
    const second = await request(base, "/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "second",
        displayName: "Second",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Setup",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { role: string }).role).toBe("user");
    const duplicate = await request(base, "/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "second",
        displayName: "Another",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Setup",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("exchanges a saved legacy refresh token once", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-server-migrate-test-"));
    const databasePath = join(root, "server.sqlite");
    paths.push(root);
    await seedAdmin(databasePath);
    const base = await start(databasePath);
    const login = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Legacy",
        platform: "desktop",
        platformDeviceId: null,
      }),
    });
    const oldSession = (await login.json()) as { sessionId: string; accessToken: string };
    const refreshToken = newOpaqueToken();
    const databaseLayer = makeDatabaseLayers({ databasePath } as never);
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const nowMs = Date.now();
        yield* database.run(sql`
        INSERT INTO refresh_tokens(id, session_id, token_hash, family_id, generation, issued_at_ms, expires_at_ms)
        VALUES (${newUuid()}, ${oldSession.sessionId}, ${hashToken(refreshToken)}, ${newUuid()}, 0, ${nowMs}, ${nowMs + 86_400_000})
      `);
      }).pipe(Effect.provide(databaseLayer)),
    );
    const migrate = () =>
      request(base, "/api/v1/auth/migrate-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    const exchanged = await migrate();
    expect(exchanged.status).toBe(200);
    const next = (await exchanged.json()) as { accessToken: string; sessionId: string };
    expect(next.sessionId).not.toBe(oldSession.sessionId);
    expect(
      (
        await request(base, "/api/v1/auth/me", {
          headers: { authorization: `Bearer ${next.accessToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(base, "/api/v1/auth/me", {
          headers: { authorization: `Bearer ${oldSession.accessToken}` },
        })
      ).status,
    ).toBe(401);
    expect((await migrate()).status).toBe(401);
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
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
        deviceId: newUuid(),
        deviceName: "Test",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(login.status).toBe(200);
    const admin = (await login.json()) as { accessToken: string };
    expect(admin.accessToken).toBeString();
    expect((await request(base, "/api/v1/auth/me")).status).toBe(401);
    const me = await request(base, "/api/v1/auth/me", {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { role: string }).role).toBe("admin");

    const userResponse = await request(base, "/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({
        username: "listener",
        displayName: "Listener",
        password: "listener password 123",
      }),
    });
    expect(userResponse.status).toBe(201);
    const user = (await userResponse.json()) as { id: string };
    const libraryResponse = await request(base, "/api/v1/libraries", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ id: newUuid(), name: "Music", slug: "music" }),
    });
    expect(libraryResponse.status).toBe(201);
    const library = (await libraryResponse.json()) as { id: string };
    const managedLibraries = await request(base, "/api/v1/admin/libraries", {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(managedLibraries.status).toBe(200);
    expect(
      ((await managedLibraries.json()) as ReadonlyArray<{ id: string }>).some(
        (value) => value.id === library.id,
      ),
    ).toBe(true);
    const updateLibrary = await request(base, `/api/v1/libraries/${library.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ name: "Music Updated", kind: "music", isEnabled: true }),
    });
    expect(updateLibrary.status).toBe(200);
    expect(((await updateLibrary.json()) as { name: string }).name).toBe("Music Updated");
    const mediaRoot = join(root, "media");
    await Bun.write(join(root, ".keep"), "");
    await mkdir(mediaRoot);
    const rootResponse = await request(base, `/api/v1/libraries/${library.id}/roots`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ id: newUuid(), libraryId: library.id, path: mediaRoot, priority: 0 }),
    });
    expect(rootResponse.status).toBe(201);
    const rootsResponse = await request(base, `/api/v1/libraries/${library.id}/roots`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(rootsResponse.status).toBe(200);
    expect(
      ((await rootsResponse.json()) as ReadonlyArray<{ isAvailable: boolean }>)[0]?.isAvailable,
    ).toBe(true);
    const userLogin = await request(base, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "listener",
        password: "listener password 123",
        deviceId: newUuid(),
        deviceName: "Listener",
        platform: "web",
        platformDeviceId: null,
      }),
    });
    expect(userLogin.status).toBe(200);
    const listener = (await userLogin.json()) as { accessToken: string };
    const scanResponse = await request(base, "/api/v1/scans", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ libraryId: library.id, mode: "full" }),
    });
    expect(scanResponse.status).toBe(202);
    const jobLog = await request(base, "/api/v1/admin/jobs?limit=100", {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(jobLog.status).toBe(200);
    expect(
      ((await jobLog.json()) as ReadonlyArray<{ libraryId: string; libraryName: string }>).some(
        (entry) => entry.libraryId === library.id && entry.libraryName === "Music Updated",
      ),
    ).toBe(true);
    expect(
      (
        await request(base, "/api/v1/admin/jobs", {
          headers: { authorization: `Bearer ${listener.accessToken}` },
        })
      ).status,
    ).toBe(403);
    const noGrant = await request(base, `/api/v1/tracks?libraryId=${library.id}`, {
      headers: { authorization: `Bearer ${listener.accessToken}` },
    });
    expect(noGrant.status).toBe(403);
    const grant = await request(base, `/api/v1/libraries/${library.id}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({
        id: newUuid(),
        libraryId: library.id,
        userId: user.id,
        role: "user",
        capabilities: ["library:read"],
        canDownload: false,
        expiresAtMs: null,
      }),
    });
    expect(grant.status).toBe(200);
    const empty = await request(base, `/api/v1/tracks?libraryId=${library.id}`, {
      headers: { authorization: `Bearer ${listener.accessToken}` },
    });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
