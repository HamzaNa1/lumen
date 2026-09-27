import { seedPlaybackFixture } from "../helpers/playback";
import { afterEach, describe, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";

const runningServers: RunningServer[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("direct-play HTTP delivery", () => {
  test("authorizes a scoped grant, supports ranges, and handles HEAD without range", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-playback-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const seeded = await seedPlaybackFixture(root, databasePath);
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
    const seeded = await seedPlaybackFixture(root, databasePath);
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
    const staleProgress = await fetch(new URL(`/api/v1/playback/sessions/${playback.sessionId}/progress`, base), {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: seeded.itemId, positionMs: 2_000, durationMs: 10_000, sequence: 5 }),
    });
    expect(staleProgress.status).toBe(200);
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
    const seeded = await seedPlaybackFixture(root, databasePath);
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
