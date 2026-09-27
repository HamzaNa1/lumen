import { seedPlaybackFixture } from "../helpers/playback";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

interface PlaybackFixture {
  readonly base: URL;
  readonly seeded: Awaited<ReturnType<typeof seedPlaybackFixture>>;
  readonly headers: Record<string, string>;
  readonly sessionUrl: URL;
  readonly streamUrl: URL;
  readonly grantHeaders: Record<string, string>;
  readonly advanceTo: (elapsedMs: number) => void;
  readonly restartServer: () => Promise<void>;
}

const withPlaybackSession = async (
  run: (fixture: PlaybackFixture) => Promise<void>,
  libraryAccessExpiresInMs?: number,
) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-playback-lifetime-test-"));
  paths.push(root);
  const databasePath = join(root, "server.sqlite");
  const seeded = await seedPlaybackFixture(root, databasePath, 7_200_000);
  let running = await startServer({ databasePath, host: "127.0.0.1", port: 0 });
  runningServers.push(running);
  const base = new URL(running.server.url);
  const startedAtMs = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(startedAtMs);
  try {
    if (libraryAccessExpiresInMs !== undefined) {
      const sqlite = new SqliteDatabase(databasePath);
      try {
        sqlite.run("UPDATE users SET role = 'user' WHERE id = ?", [seeded.userId]);
        sqlite.run(
          `INSERT INTO library_grants(id, library_id, user_id, role, capabilities_json, expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'user', '["library:read","playback:control"]', ?, ?, ?)`,
          [
            newUuid(),
            seeded.libraryId,
            seeded.userId,
            startedAtMs + libraryAccessExpiresInMs,
            startedAtMs,
            startedAtMs,
          ],
        );
      } finally {
        sqlite.close();
      }
    }
    const deviceId = newUuid();
    const login = await fetch(new URL("/api/v1/auth/login", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
        deviceId,
        deviceName: "Playback test",
        platform: "desktop",
        platformDeviceId: deviceId,
      }),
    });
    expect(login.status).toBe(200);
    const auth = (await login.json()) as { accessToken: string };
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessToken}`,
    };
    const started = await fetch(new URL("/api/v1/playback/sessions", base), {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: seeded.itemId }),
    });
    expect(started.status).toBe(201);
    const playback = (await started.json()) as {
      sessionId: string;
      grantToken: string;
      streamUrl: string;
    };
    const sessionUrl = new URL(`/api/v1/playback/sessions/${playback.sessionId}`, base);
    await run({
      base,
      seeded,
      headers,
      sessionUrl,
      streamUrl: new URL(playback.streamUrl, base),
      grantHeaders: { authorization: `Bearer ${playback.grantToken}`, range: "bytes=2-5" },
      advanceTo: (elapsedMs) => {
        clock.mockReturnValue(startedAtMs + elapsedMs);
      },
      restartServer: async () => {
        const port = running.server.port;
        await running.stop();
        runningServers.splice(runningServers.indexOf(running), 1);
        running = await startServer({ databasePath, host: "127.0.0.1", port });
        runningServers.push(running);
      },
    });
  } finally {
    clock.mockRestore();
  }
};

describe("direct-play HTTP delivery", () => {
  test("preserves manual watch-state changes against paused reports and allows a new session", async () => {
    await withPlaybackSession(async ({ base, seeded, headers, sessionUrl, restartServer }) => {
      const itemUrl = new URL(`/api/v1/items/${seeded.itemId}`, base);
      const report = async (url: URL, sequence: number, positionMs = 4_000) => {
        const response = await fetch(`${url}/progress`, {
          method: "POST",
          headers,
          body: JSON.stringify({ trackId: seeded.itemId, positionMs, durationMs: 10_000, sequence }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ positionMs });
      };
      const expectWatchState = async (positionSeconds: number, completed: boolean) => {
        const response = await fetch(itemUrl, { headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ watchState: { positionSeconds, completed } });
      };
      const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state: "paused", activeTrackId: seeded.itemId, errorCode: null }),
      });
      expect(heartbeat.status).toBe(200);
      await heartbeat.arrayBuffer();
      await report(sessionUrl, 1);
      await expectWatchState(4, false);
      const manual = await fetch(`${itemUrl}/watch-state`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ positionSeconds: 0, completed: true }),
      });
      expect(manual.status).toBe(200);
      await manual.arrayBuffer();
      await expectWatchState(0, true);
      await restartServer();
      await report(sessionUrl, 2);
      await expectWatchState(0, true);
      const home = await fetch(new URL("/api/v1/home", base), { headers });
      expect(home.status).toBe(200);
      expect(await home.json()).toMatchObject({ continueWatching: [] });
      const started = await fetch(new URL("/api/v1/playback/sessions", base), {
        method: "POST",
        headers,
        body: JSON.stringify({ trackId: seeded.itemId }),
      });
      expect(started.status).toBe(201);
      const playback = await started.json() as { sessionId: string };
      await report(new URL(`/api/v1/playback/sessions/${playback.sessionId}`, base), 1);
      await expectWatchState(4, false);
      await report(sessionUrl, 3, 2_000);
      await expectWatchState(4, false);
    });
  });

  for (const completed of [true, false]) {
    test(`preserves a manual completed=${completed} change before the first progress report`, async () => {
      await withPlaybackSession(async ({ base, seeded, headers, sessionUrl }) => {
        const itemUrl = new URL(`/api/v1/items/${seeded.itemId}`, base);
        const manual = await fetch(`${itemUrl}/watch-state`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ positionSeconds: 0, completed }),
        });
        expect(manual.status).toBe(200);
        await manual.arrayBuffer();
        const progress = await fetch(`${sessionUrl}/progress`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            trackId: seeded.trackId,
            positionMs: completed ? 4_000 : 9_500,
            durationMs: 10_000,
            sequence: 0,
          }),
        });
        expect(progress.status).toBe(200);
        await progress.arrayBuffer();
        const details = await fetch(itemUrl, { headers });
        expect(details.status).toBe(200);
        expect(await details.json()).toMatchObject({ watchState: { positionSeconds: 0, completed } });
      });
    });
  }

  test("cannot renew media access with a null active track after library access expires", async () => {
    await withPlaybackSession(
      async ({ headers, sessionUrl, streamUrl, grantHeaders, advanceTo }) => {
        advanceTo(20_000);
        const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "paused", activeTrackId: null, errorCode: null }),
        });
        expect(heartbeat.status).toBe(200);
        await heartbeat.arrayBuffer();
        advanceTo(60_000);
        const denied = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "paused", activeTrackId: null, errorCode: null }),
        });
        expect(denied.status).toBe(403);
        await denied.arrayBuffer();
        advanceTo(3_620_000);
        const expired = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "paused", activeTrackId: null, errorCode: null }),
        });
        expect(expired.status).toBe(409);
        await expired.arrayBuffer();
        const media = await fetch(streamUrl, { headers: grantHeaders });
        expect(media.status).toBe(404);
        await media.arrayBuffer();
      },
      60_000,
    );
  });

  test("does not let another user renew a playback session", async () => {
    await withPlaybackSession(
      async ({ base, seeded, headers, sessionUrl, streamUrl, grantHeaders, advanceTo }) => {
        const deviceId = newUuid();
        const registration = await fetch(new URL("/api/v1/auth/register", base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "other",
            displayName: "Other",
            password: "correct horse battery staple",
            deviceId,
            deviceName: "Other device",
            platform: "desktop",
            platformDeviceId: deviceId,
          }),
        });
        expect(registration.status).toBe(201);
        const other = (await registration.json()) as { accessToken: string };
        advanceTo(3_580_000);
        const denied = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${other.accessToken}`,
          },
          body: JSON.stringify({ state: "playing", activeTrackId: seeded.itemId, errorCode: null }),
        });
        expect(denied.status).toBe(403);
        await denied.arrayBuffer();
        advanceTo(3_600_000);
        const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "playing", activeTrackId: seeded.itemId, errorCode: null }),
        });
        expect(heartbeat.status).toBe(409);
        await heartbeat.arrayBuffer();
        const media = await fetch(streamUrl, { headers: grantHeaders });
        expect(media.status).toBe(404);
        await media.arrayBuffer();
      },
    );
  });

  for (const ending of ["abandoned", "stopped"] as const) {
    test(`rejects heartbeats, progress, and media for ${ending} sessions`, async () => {
      await withPlaybackSession(
        async ({ seeded, headers, sessionUrl, streamUrl, grantHeaders, advanceTo }) => {
          if (ending === "stopped") {
            advanceTo(20_000);
            const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                state: "playing",
                activeTrackId: seeded.itemId,
                errorCode: null,
              }),
            });
            expect(heartbeat.status).toBe(200);
            await heartbeat.arrayBuffer();
            const stopped = await fetch(sessionUrl, { method: "DELETE", headers });
            expect(stopped.status).toBe(200);
            await stopped.arrayBuffer();
            advanceTo(40_000);
          } else {
            advanceTo(3_600_000);
          }
          const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              state: "playing",
              activeTrackId: seeded.itemId,
              errorCode: null,
            }),
          });
          expect(heartbeat.status).toBe(409);
          expect(await heartbeat.json()).toMatchObject({ message: "Playback session is closed" });
          const progress = await fetch(`${sessionUrl}/progress`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              trackId: seeded.itemId,
              positionMs: 4_000,
              durationMs: 7_200_000,
              sequence: 1,
            }),
          });
          expect(progress.status).toBe(409);
          await progress.arrayBuffer();
          const media = await fetch(streamUrl, { headers: grantHeaders });
          expect(media.status).toBe(404);
          expect(await media.json()).toMatchObject({
            message: "Playback grant is invalid or expired",
          });
        },
      );
    });
  }

  test("keeps progress and the original media grant usable beyond one hour with heartbeats", async () => {
    await withPlaybackSession(
      async ({ base, seeded, headers, sessionUrl, streamUrl, grantHeaders, advanceTo }) => {
        for (let elapsedMs = 20_000; elapsedMs <= 4_000_000; elapsedMs += 20_000) {
          advanceTo(elapsedMs);
          const heartbeat = await fetch(`${sessionUrl}/heartbeat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              state: "playing",
              activeTrackId: seeded.itemId,
              errorCode: null,
            }),
          });
          expect(heartbeat.status).toBe(200);
          await heartbeat.arrayBuffer();
        }
        const progress = await fetch(`${sessionUrl}/progress`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            trackId: seeded.itemId,
            positionMs: 4_000_000,
            durationMs: 7_200_000,
            sequence: 1,
          }),
        });
        expect(progress.status).toBe(200);
        expect(await progress.json()).toMatchObject({ positionMs: 4_000_000 });
        const details = await fetch(new URL(`/api/v1/items/${seeded.itemId}`, base), { headers });
        expect(details.status).toBe(200);
        expect(await details.json()).toMatchObject({ watchState: { positionSeconds: 4_000 } });
        const partial = await fetch(streamUrl, { headers: grantHeaders });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
        expect(await partial.text()).toBe("2345");
        advanceTo(7_600_000);
        const expired = await fetch(`${sessionUrl}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "playing", activeTrackId: seeded.itemId, errorCode: null }),
        });
        expect(expired.status).toBe(409);
        await expired.arrayBuffer();
        const expiredMedia = await fetch(streamUrl, { headers: grantHeaders });
        expect(expiredMedia.status).toBe(404);
        await expiredMedia.arrayBuffer();
      },
    );
  });

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
