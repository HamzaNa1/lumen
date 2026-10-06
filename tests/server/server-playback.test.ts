import { resolveTrackSelection, type PlayerSession } from "../../packages/contracts/src/index.ts";
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
  readonly databasePath: string;
  readonly root: string;
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
          `INSERT INTO library_grants(id, library_id, user_id, capabilities_json, expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, '["library:read","playback:control"]', ?, ?, ?)`,
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
      databasePath,
      root,
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
        const created = await fetch(new URL("/api/v1/users", base), {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: "other",
            displayName: "Other",
            password: "correct horse battery staple",
          }),
        });
        expect(created.status).toBe(201);
        await created.arrayBuffer();
        const login = await fetch(new URL("/api/v1/auth/login", base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "other",
            password: "correct horse battery staple",
            deviceId,
            deviceName: "Other device",
            platform: "desktop",
            platformDeviceId: deviceId,
          }),
        });
        expect(login.status).toBe(200);
        const other = (await login.json()) as { accessToken: string };
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
    expect(await identity.json()).toMatchObject({ capabilities: { trackMemory: true } });
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

describe("account track memory HTTP API", () => {
  const jsonRequest = async (base: URL, headers: Record<string, string>, path: string, method = "GET", input?: unknown) =>
    fetch(new URL(path, base), { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const start = async (base: URL, headers: Record<string, string>, itemId: string): Promise<PlayerSession> => {
    const response = await jsonRequest(base, headers, "/api/v1/playback/sessions", "POST", { trackId: itemId });
    expect(response.status).toBe(201);
    return response.json();
  };
  test("defaults, partial updates, movie revisits and server restart preserve independent choices", async () => {
    await withPlaybackSession(async ({ base, headers, seeded, sessionUrl, restartServer }) => {
      const path = "/api/v1/me/track-preferences";
      expect(await (await jsonRequest(base, headers, path)).json()).toEqual({ audioLanguage: "en", subtitleLanguage: null });
      expect(await (await jsonRequest(base, headers, path, "PATCH", { subtitleLanguage: "fr" })).json()).toEqual({ audioLanguage: "en", subtitleLanguage: "fr" });
      const save = async (input: unknown) => {
        const response = await fetch(`${sessionUrl}/track-choice`, { method: "PUT", headers, body: JSON.stringify(input) });
        expect(response.status).toBe(200); return response.json();
      };
      await save({ kind: "audio", choice: seeded.audioStreamId });
      await save({ kind: "subtitle", choice: "off" });
      await jsonRequest(base, headers, path, "PATCH", { audioLanguage: "ja", subtitleLanguage: "en" });
      const deviceId = newUuid();
      const login = await jsonRequest(base, headers, "/api/v1/auth/login", "POST", {
        username: "admin", password: "correct horse battery staple", deviceId,
        deviceName: "Second device", platform: "desktop", platformDeviceId: deviceId,
      });
      expect(login.status).toBe(200);
      const token = await login.json() as { accessToken: string };
      const deviceHeaders = { ...headers, authorization: `Bearer ${token.accessToken}` };
      const otherDevice = await start(base, deviceHeaders, seeded.itemId);
      expect(otherDevice.trackMemory).toMatchObject({ preferences: { audioLanguage: "ja", subtitleLanguage: "en" }, audio: { streamId: seeded.audioStreamId }, subtitle: "off" });
      expect((await fetch(`${sessionUrl}/track-choice`, { method: "PUT", headers: deviceHeaders, body: JSON.stringify({ kind: "subtitle", choice: null }) })).status).toBe(403);
      await restartServer();
      const revisited = await start(base, headers, seeded.itemId);
      expect(revisited.trackMemory).toMatchObject({ preferences: { audioLanguage: "ja", subtitleLanguage: "en" }, audio: { streamId: seeded.audioStreamId }, subtitle: "off" });
      expect(resolveTrackSelection(revisited.streams, revisited.sourceId, revisited.trackMemory)).toMatchObject({ audio: { id: seeded.audioStreamId }, subtitle: null });
      const resetPath = `/api/v1/playback/sessions/${revisited.sessionId}/track-choice`;
      const audioReset = await jsonRequest(base, headers, resetPath, "PUT", { kind: "audio", choice: null });
      expect(await audioReset.json()).toMatchObject({ audio: null, subtitle: "off" });
      const subtitleReset = await jsonRequest(base, headers, resetPath, "PUT", { kind: "subtitle", choice: null });
      expect(await subtitleReset.json()).toMatchObject({ audio: null, subtitle: null });
      const inherited = await start(base, headers, seeded.itemId);
      expect(resolveTrackSelection(inherited.streams, inherited.sourceId, inherited.trackMemory).subtitle?.id).toBe(seeded.subtitleStreamId);
      expect((await jsonRequest(base, headers, path, "PATCH", { audioLanguage: "not a language" })).status).toBe(400);
    });
  });

  test("show choices span episodes and seasons, survive absence, and match regenerated IDs", async () => {
    await withPlaybackSession(async ({ base, headers, seeded, sessionUrl, databasePath, root, restartServer }) => {
      const db = new SqliteDatabase(databasePath);
      try {
        const source = db.query("SELECT source_id FROM tracks WHERE id = ?").get(seeded.trackId) as { source_id: string };
        const show = newUuid(), season1 = newUuid(), season2 = newUuid();
        const item = (id: string, kind: string, parent: string | null) => db.run(`INSERT INTO catalog_items(id, library_id, kind, parent_id, title, sort_title, added_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'Test', 'test', 1, 1)`, [id, seeded.libraryId, kind, parent]);
        item(show, "show", null); item(season1, "season", show); item(season2, "season", show);
        db.run("UPDATE catalog_items SET kind = 'episode', parent_id = ? WHERE id = ?", [season1, seeded.itemId]);
        db.run("UPDATE streams SET commentary = 0, forced = 0, hearing_impaired = 0 WHERE source_id = ?", [source.source_id]);
        const commentaryId = newUuid();
        db.run(`INSERT INTO streams(id, source_id, kind, codec, language, title, ordinal, is_default, channels, commentary, forced, hearing_impaired) VALUES (?, ?, 'audio', 'aac', 'eng', 'Commentary', 3, 0, 2, 1, 0, 0)`, [commentaryId, source.source_id]);
        db.run("UPDATE streams SET hearing_impaired = 1 WHERE id = ?", [seeded.subtitleStreamId]);
        const episode = async (name: string, season: string, includeCommentary: boolean) => {
          const sourceId = newUuid(), itemId = newUuid(), videoId = newUuid(), regularId = newUuid(), commentId = newUuid(), subId = newUuid();
          await Bun.write(join(root, name), "0123456789");
          db.run(`INSERT INTO media_sources(id, library_id, root_id, relative_path, absolute_path, kind, file_size_bytes, modified_at_ms, scanned_at_ms) SELECT ?, library_id, root_id, ?, ?, kind, file_size_bytes, modified_at_ms, scanned_at_ms FROM media_sources WHERE id = ?`, [sourceId, name, join(root, name), source.source_id]);
          for (const [originalId, nextId, ordinal] of [[seeded.audioStreamId, regularId, 2], [commentaryId, commentId, 1], [seeded.subtitleStreamId, subId, 4]] as const) {
            if (!includeCommentary && originalId === commentaryId) continue;
            db.run(`INSERT INTO streams(id, source_id, kind, codec, language, title, ordinal, channels, commentary, forced, hearing_impaired) SELECT ?, ?, kind, codec, language, title, ?, channels, commentary, forced, hearing_impaired FROM streams WHERE id = ?`, [nextId, sourceId, ordinal, originalId]);
          }
          db.run("INSERT INTO streams(id, source_id, kind, ordinal) VALUES (?, ?, 'video', 0)", [videoId, sourceId]);
          db.run(`INSERT INTO tracks(id, library_id, source_id, primary_stream_id, title, normalized_title, duration_ms, created_at_ms, updated_at_ms) SELECT ?, library_id, ?, ?, title, normalized_title, duration_ms, 1, 1 FROM tracks WHERE id = ?`, [newUuid(), sourceId, videoId, seeded.trackId]);
          item(itemId, "episode", season);
          db.run("INSERT INTO catalog_item_sources(item_id, source_id, is_primary) VALUES (?, ?, 1)", [itemId, sourceId]);
          return { itemId, sourceId, regularId, commentId, subId };
        };
        const second = await episode("second.mkv", season1, false);
        const third = await episode("third.mkv", season2, true);
        for (const [kind, choice] of [["audio", commentaryId], ["subtitle", seeded.subtitleStreamId]]) {
          const response = await fetch(`${sessionUrl}/track-choice`, { method: "PUT", headers, body: JSON.stringify({ kind, choice }) });
          expect(response.status).toBe(200); await response.arrayBuffer();
        }
        const missing = await start(base, headers, second.itemId);
        expect(resolveTrackSelection(missing.streams, missing.sourceId, missing.trackMemory)).toMatchObject({ audio: { id: second.regularId }, subtitle: { id: second.subId } });
        expect(missing.trackMemory?.audio?.streamId).toBe(commentaryId);
        await restartServer();
        const available = await start(base, headers, third.itemId);
        expect(resolveTrackSelection(available.streams, available.sourceId, available.trackMemory)).toMatchObject({ audio: { id: third.commentId }, subtitle: { id: third.subId } });
        const rows = db.query("SELECT item_id FROM media_track_overrides").all();
        expect(rows).toEqual([{ item_id: show }]);
        // Rescanning replaces a stream ID, not the saved metadata descriptor.
        const replacement = newUuid();
        db.run("UPDATE streams SET id = ? WHERE id = ?", [replacement, third.commentId]);
        const rescanned = await start(base, headers, third.itemId);
        expect(resolveTrackSelection(rescanned.streams, rescanned.sourceId, rescanned.trackMemory).audio?.id).toBe(replacement);
      } finally { db.close(); }
    });
  });

  test("accounts and devices are isolated; foreign streams, closed sessions and lost access are rejected", async () => {
    await withPlaybackSession(async ({ base, headers, seeded, sessionUrl, databasePath }) => {
      const created = await jsonRequest(base, headers, "/api/v1/users", "POST", { username: "viewer", displayName: "Viewer", password: "correct horse battery staple", libraryAccess: { scope: "all" } });
      expect(created.status).toBe(201);
      const user = await created.json() as { id: string };
      const deviceId = newUuid();
      const login = await jsonRequest(base, headers, "/api/v1/auth/login", "POST", { username: "viewer", password: "correct horse battery staple", deviceId, deviceName: "test", platform: "desktop", platformDeviceId: deviceId });
      expect(login.status).toBe(200);
      const token = await login.json() as { accessToken: string };
      const otherHeaders = { ...headers, authorization: `Bearer ${token.accessToken}` };
      const path = "/api/v1/me/track-preferences";
      await jsonRequest(base, headers, path, "PATCH", { audioLanguage: "fr" });
      expect(await (await jsonRequest(base, otherHeaders, path)).json()).toMatchObject({ audioLanguage: "en" });
      const choicePath = `${sessionUrl}/track-choice`;
      expect((await fetch(choicePath, { method: "PUT", headers: otherHeaders, body: JSON.stringify({ kind: "subtitle", choice: "off" }) })).status).toBe(403);
      expect((await fetch(choicePath, { method: "PUT", headers, body: JSON.stringify({ kind: "audio", choice: seeded.subtitleStreamId }) })).status).toBe(400);
      expect((await fetch(choicePath, { method: "PUT", headers, body: JSON.stringify({ kind: "audio", choice: newUuid() }) })).status).toBe(400);
      expect((await fetch(choicePath, { method: "PUT", headers, body: JSON.stringify({ kind: "audio", choice: "off" }) })).status).toBe(400);
      const own = await start(base, otherHeaders, seeded.itemId);
      expect(own.trackMemory?.audio).toBeNull();
      const db = new SqliteDatabase(databasePath);
      try { db.run("UPDATE users SET all_libraries = 0 WHERE id = ?", [user.id]); } finally { db.close(); }
      expect((await jsonRequest(base, otherHeaders, `/api/v1/playback/sessions/${own.sessionId}/track-choice`, "PUT", { kind: "subtitle", choice: "off" })).status).toBe(403);
      await fetch(sessionUrl, { method: "DELETE", headers });
      expect((await fetch(choicePath, { method: "PUT", headers, body: JSON.stringify({ kind: "subtitle", choice: "off" }) })).status).toBe(409);
    });
  });
});
