import { afterEach, describe, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { Database, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { hashPassword, newUuid } from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

const runningServers: RunningServer[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const seed = async (root: string, databasePath: string): Promise<{ readonly userId: string; readonly libraryId: string; readonly trackId: string; readonly itemId: string; readonly audioStreamId: string; readonly subtitleStreamId: string }> => {
  const mediaPath = join(root, "clip.mkv");
  await Bun.write(mediaPath, "0123456789");
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const layer = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer));
  return Effect.runPromise(Effect.gen(function* () {
    const database = yield* Database;
    const userId = newUuid();
    const libraryId = newUuid();
    const trackId = newUuid();
    const itemId = newUuid();
    yield* database.run(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${userId}, 'admin', 'admin', 'Admin', ${yield* Effect.promise(() => hashPassword("correct horse battery staple"))}, 'admin', 1, unixepoch() * 1000, unixepoch() * 1000)
    `);
    yield* database.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, unixepoch() * 1000, unixepoch() * 1000)`);
    yield* database.run(sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`);
    const sourceId = newUuid();
    const streamId = newUuid();
    const audioStreamId = newUuid();
    const subtitleStreamId = newUuid();
    const rootId = newUuid();
    yield* database.run(sql`
      INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms)
      VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, unixepoch() * 1000, unixepoch() * 1000)
    `);
    yield* database.run(sql`
      INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, inode, scanned_at_ms)
      VALUES (${sourceId}, ${libraryId}, ${rootId}, 'clip.mkv', ${mediaPath}, 'local', 10, unixepoch() * 1000, '1', unixepoch() * 1000)
    `);
    const source = yield* database.get<{ id: string }>(sql`SELECT id FROM media_sources WHERE absolute_path = ${mediaPath}`);
    if (source !== null) {
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, container, codec, ordinal, is_default) VALUES (${streamId}, ${source.id}, 'video', 'matroska', 'h264', 0, 1)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default) VALUES (${audioStreamId}, ${source.id}, 'audio', 'matroska', 'aac', 'eng', 'English', 1, 1)`);
      yield* database.run(sql`INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default) VALUES (${subtitleStreamId}, ${source.id}, 'subtitle', 'matroska', 'subrip', 'eng', 'English', 2, 1)`);
      yield* database.run(sql`
        INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, duration_ms, is_explicit, created_at_ms, updated_at_ms)
        VALUES (${trackId}, ${libraryId}, ${source.id}, ${streamId}, 'Clip', 'clip', 10000, 0, unixepoch() * 1000, unixepoch() * 1000)
      `);
      yield* database.run(sql`
        INSERT INTO catalog_items(id, library_id, kind, title, sort_title, duration_seconds, metadata_state, added_at_ms, updated_at_ms)
        VALUES (${itemId}, ${libraryId}, 'movie', 'Clip', 'clip', 10, 'local', unixepoch() * 1000, unixepoch() * 1000)
      `);
      yield* database.run(sql`INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation) VALUES (${itemId}, ${source.id}, 1, 1)`);
    }
    return { userId, libraryId, trackId, itemId, audioStreamId, subtitleStreamId };
  }).pipe(Effect.provide(layer)));
};

describe("direct-play HTTP delivery", () => {
  test("authorizes a scoped grant, supports ranges, and handles HEAD without range", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-playback-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const seeded = await seed(root, databasePath);
    const running = await startServer({ databasePath, host: "127.0.0.1", port: 0 });
    runningServers.push(running);
    const base = new URL(running.server.url);
    const identity = await fetch(new URL("/api/v1/server", base));
    expect(identity.status).toBe(200);
    const deviceId = newUuid();
    const login = await fetch(new URL("/api/v1/auth/login", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple", deviceId, deviceName: "Playback test", platform: "desktop", platformDeviceId: deviceId }),
    });
    const session = await login.json() as { accessToken: string };
    const started = await fetch(new URL("/api/v1/playback/sessions", base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ trackId: seeded.itemId }),
    });
    expect(started.status).toBe(201);
    const playback = await started.json() as {
      sessionId: string;
      grantToken: string;
      streamUrl: string;
      streams: ReadonlyArray<{ id: string; kind: string; ordinal: number; language: string | null; title: string | null; isDefault: boolean }>;
    };
    expect(playback.streams.every((stream) => typeof stream.isDefault === "boolean")).toBe(true);
    expect(playback.streams).toEqual([
      expect.objectContaining({ id: seeded.audioStreamId, kind: "audio", ordinal: 1, language: "eng", title: "English" }),
      expect.objectContaining({ id: seeded.subtitleStreamId, kind: "subtitle", ordinal: 2, language: "eng", title: "English" }),
    ]);
    const streamUrl = new URL(playback.streamUrl, base);
    const full = await fetch(streamUrl, { headers: { authorization: `Bearer ${playback.grantToken}` } });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/x-matroska");
    expect(full.headers.get("content-length")).toBe("10");
    expect(await full.text()).toBe("0123456789");
    const partial = await fetch(streamUrl, { headers: { authorization: `Bearer ${playback.grantToken}`, range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");
    const head = await fetch(streamUrl, { method: "HEAD", headers: { authorization: `Bearer ${playback.grantToken}`, range: "bytes=2-5" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    const denied = await fetch(streamUrl, { headers: { authorization: "Bearer invalid" } });
    expect(denied.status).toBe(404);
  });

  test("accepts heartbeats and stores progress on the existing session", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-playback-progress-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const seeded = await seed(root, databasePath);
    const running = await startServer({ databasePath, host: "127.0.0.1", port: 0 });
    runningServers.push(running);
    const base = new URL(running.server.url);
    const deviceId = newUuid();
    const login = await fetch(new URL("/api/v1/auth/login", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple", deviceId, deviceName: "Playback test", platform: "desktop", platformDeviceId: deviceId }),
    });
    const session = await login.json() as { accessToken: string };
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
    const started = await fetch(new URL("/api/v1/playback/sessions", base), {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: seeded.itemId }),
    });
    expect(started.status).toBe(201);
    const playback = await started.json() as { sessionId: string };
    const heartbeat = await fetch(new URL(`/api/v1/playback/sessions/${playback.sessionId}/heartbeat`, base), {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "playing", activeTrackId: seeded.itemId, errorCode: null }),
    });
    expect(heartbeat.status).toBe(200);
    const progress = await fetch(new URL(`/api/v1/playback/sessions/${playback.sessionId}/progress`, base), {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: seeded.itemId, positionMs: 4_000, durationMs: 10_000, sequence: 6 }),
    });
    expect(progress.status).toBe(200);
    const sqlite = new SqliteDatabase(databasePath, { readonly: true });
    try {
      const sessions = sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM playback_sessions").get();
      expect(sessions?.count).toBe(1);
      const watchState = sqlite.query<{ positionSeconds: number }, [string, string]>("SELECT position_seconds AS positionSeconds FROM item_watch_states WHERE user_id = ? AND item_id = ?").get(seeded.userId, seeded.itemId);
      expect(watchState?.positionSeconds).toBe(4);
    } finally {
      sqlite.close();
    }
  });

  test("uses the access-token session device when the renderer device is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-playback-device-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const seeded = await seed(root, databasePath);
    const running = await startServer({ databasePath, host: "127.0.0.1", port: 0 });
    runningServers.push(running);
    const base = new URL(running.server.url);
    const sessionDeviceId = newUuid();
    const login = await fetch(new URL("/api/v1/auth/login", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple", deviceId: sessionDeviceId, deviceName: "Playback test", platform: "desktop", platformDeviceId: sessionDeviceId }),
    });
    const session = await login.json() as { accessToken: string };
    const started = await fetch(new URL("/api/v1/playback/sessions", base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ deviceId: newUuid(), trackId: seeded.itemId }),
    });
    expect(started.status).toBe(201);
    const playback = await started.json() as { sessionId: string };
    const sqlite = new SqliteDatabase(databasePath, { readonly: true });
    try {
      const storedDevice = sqlite.query<{ deviceId: string }, [string]>("SELECT device_id AS deviceId FROM playback_sessions WHERE id = ?").get(playback.sessionId);
      expect(storedDevice?.deviceId).toBe(sessionDeviceId);
    } finally {
      sqlite.close();
    }
  });
});
