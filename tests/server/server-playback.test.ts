import { seedPlayback } from "../helpers/playback";
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


describe("direct-play HTTP delivery", () => {
  test("authorizes a scoped grant, supports ranges, and handles HEAD without range", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-playback-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const seeded = await seedPlayback(root, databasePath);
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
    const seeded = await seedPlayback(root, databasePath);
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
    const seeded = await seedPlayback(root, databasePath);
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

describe("watch groups HTTP API", () => {
  const setupGroup = async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-watch-group-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const media = await seedPlayback(root, databasePath);
    const running = await startServer({ databasePath, dataDir: root, host: "127.0.0.1", port: 0 });
    runningServers.push(running);
    const login = async (username = "admin") => {
      const deviceId = newUuid();
      const response = await fetch(new URL("/api/v1/auth/login", running.server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "correct horse battery staple", deviceId, deviceName: "Group test", platform: "desktop", platformDeviceId: deviceId }),
      });
      expect(response.status).toBe(200);
      const session = await response.json() as { accessToken: string };
      return (path: string, method = "GET", body?: unknown) => fetch(new URL(`/api/v1${path}`, running.server.url), {
        method, headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    return { media, first: await login(), second: await login(), outsider: await login(), running, login };
  };

  test("open groups admit another device, protected groups require the password and never expose it", async () => {
    const { first, second, outsider, running } = await setupGroup();
    expect((await fetch(new URL("/api/v1/watch-groups", running.server.url))).status).toBe(401);
    const created = await first("/watch-groups", "POST", { name: "Friday movie night", password: "friends-only" });
    expect(created.status).toBe(201);
    const { group } = await created.json() as { group: { id: string } };
    const listed = await (await second("/watch-groups")).json();
    expect(JSON.stringify(listed)).not.toContain("friends-only");
    expect(JSON.stringify(listed)).not.toContain("passwordHash");
    expect(listed.groups[0]).toMatchObject({ name: "Friday movie night", passwordProtected: true });
    expect((await second(`/watch-groups/${group.id}/join`, "POST", { password: "wrong" })).status).toBe(403);
    expect((await outsider(`/watch-groups/${group.id}`)).status).toBe(403);
    expect((await second(`/watch-groups/${group.id}/join`, "POST", { password: "friends-only" })).status).toBe(200);
    const joined = await (await first(`/watch-groups/${group.id}`)).json();
    expect(joined.group.members).toHaveLength(2);
    await second(`/watch-groups/${group.id}`, "DELETE");
    await first(`/watch-groups/${group.id}`, "DELETE");
    expect((await (await outsider("/watch-groups")).json()).groups).toEqual([]);
    const open = await (await first("/watch-groups", "POST", { name: "Open group" })).json();
    expect((await second(`/watch-groups/${open.group.id}/join`, "POST", {})).status).toBe(200);
  });

  test("late joins receive current media and timeline; any member can pause, seek, resume, and stop", async () => {
    const { media, first, second, outsider } = await setupGroup();
    const created = await (await first("/watch-groups", "POST", { name: "Watch together" })).json();
    const path = `/watch-groups/${created.group.id}`;
    const start = await first(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 3 });
    expect(start.status).toBe(200);
    const started = await start.json();
    const playbackId = started.group.playback.id;
    expect((await outsider(`${path}/commands`, "POST", { type: "pause", playbackId })).status).toBe(403);
    const joined = await (await second(`${path}/join`, "POST", {})).json();
    expect(joined.group.playback).toMatchObject({ id: playbackId, itemId: media.itemId, positionSeconds: 3, paused: false });
    expect(joined.serverTimeMs).toBeGreaterThanOrEqual(joined.group.playback.updatedAtMs);
    const waiting = first(`${path}?after=${joined.group.revision}`);
    const paused = await (await second(`${path}/commands`, "POST", { type: "pause", playbackId })).json();
    expect(paused.group.playback.paused).toBe(true);
    expect(paused.group.playback.positionSeconds).toBeGreaterThanOrEqual(3);
    expect((await (await waiting).json()).group.playback.paused).toBe(true);
    expect((await first(`${path}/commands`, "POST", { type: "seek", playbackId, positionSeconds: 11 })).status).toBe(400);
    const sought = await (await second(`${path}/commands`, "POST", { type: "seek", playbackId, positionSeconds: 7 })).json();
    expect(sought.group.playback).toMatchObject({ paused: true, positionSeconds: 7 });
    const late = await (await outsider(`${path}/join`, "POST", {})).json();
    expect(late.group.playback).toMatchObject({ itemId: media.itemId, paused: true, positionSeconds: 7 });
    const resumed = await (await outsider(`${path}/commands`, "POST", { type: "resume", playbackId })).json();
    expect(resumed.group.playback.paused).toBe(false);
    const replacement = await (await second(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 1 })).json();
    expect(replacement.group.playback.id).not.toBe(playbackId);
    expect((await first(`${path}/commands`, "POST", { type: "stop", playbackId })).status).toBe(409);
    await second(`${path}/commands`, "POST", { type: "stop", playbackId: replacement.group.playback.id });
    expect((await (await first(path)).json()).group.playback).toBeNull();
  });

  test("rejects invalid names, invalid positions, and simultaneous memberships", async () => {
    const { first, second, media } = await setupGroup();
    expect((await first("/watch-groups", "POST", { name: "   " })).status).toBe(400);
    const results = await Promise.all([
      first("/watch-groups", "POST", { name: "First" }),
      first("/watch-groups", "POST", { name: "Second" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const created = await results.find((response) => response.status === 201)?.json();
    const path = `/watch-groups/${created.group.id}`;
    expect((await first(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: -1 })).status).toBe(400);
    await first(`${path}`, "DELETE");
    expect((await second(`${path}/join`, "POST", {})).status).toBe(404);
  });
  test("regular users can create and join groups without receiving access to restricted media", async () => {
    const { media, first, login } = await setupGroup();
    const user = await first("/users", "POST", { username: "friend", displayName: "Friend", password: "correct horse battery staple", role: "user" });
    expect(user.status).toBe(201);
    const friend = await login("friend");
    const created = await (await friend("/watch-groups", "POST", { name: "Friends" })).json();
    const path = `/watch-groups/${created.group.id}`;
    expect((await first(`${path}/join`, "POST", {})).status).toBe(200);
    expect((await friend(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 0 })).status).toBe(403);
    expect((await first(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 0 })).status).toBe(403);
    await friend(path, "DELETE");
    expect((await first(`${path}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 0 })).status).toBe(200);
    expect((await friend(`${path}/join`, "POST", {})).status).toBe(403);
    const list = await (await friend("/watch-groups")).json();
    expect(list.groups[0]).not.toHaveProperty("playback");
  });

  test("group polling does not consume the sign-in attempt budget for other viewers", async () => {
    const { first, login } = await setupGroup();
    for (let index = 0; index < 12; index++) expect((await first("/watch-groups")).status).toBe(200);
    await login();
  });

  test("a slow password check cannot delay another group's pause command", async () => {
    const { first, second, outsider, media } = await setupGroup();
    const watching = await (await first("/watch-groups", "POST", { name: "Watching" })).json();
    const started = await (await first(`/watch-groups/${watching.group.id}/commands`, "POST", { type: "start", itemId: media.itemId, positionSeconds: 0 })).json();
    const protectedGroup = await (await second("/watch-groups", "POST", { name: "Protected", password: "groupSecret" })).json();
    const verificationStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const original = Bun.password.verify;
    const verify = spyOn(Bun.password, "verify").mockImplementation((password, hash, algorithm) => {
      if (password === "groupSecret") { verificationStarted.resolve(); return release.promise; }
      return original(password, hash, algorithm);
    });
    const joining = outsider(`/watch-groups/${protectedGroup.group.id}/join`, "POST", { password: "groupSecret" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await verificationStarted.promise;
      const paused = first(`/watch-groups/${watching.group.id}/commands`, "POST", { type: "pause", playbackId: started.group.playback.id });
      const result = await Promise.race([paused.then((response) => response.status), new Promise<string>((resolve) => { timeout = setTimeout(() => resolve("blocked"), 1000); })]);
      expect(result).toBe(200);
    } finally {
      clearTimeout(timeout);
      release.resolve(true);
      await joining;
      verify.mockRestore();
    }
  });

  test("disconnected members expire and empty watch groups disappear", async () => {
    const { first, second } = await setupGroup();
    const created = await (await first("/watch-groups", "POST", { name: "Temporary" })).json();
    await second(`/watch-groups/${created.group.id}/join`, "POST", {});
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 46000);
    try {
      expect((await (await first("/watch-groups")).json()).groups).toEqual([]);
      expect((await second(`/watch-groups/${created.group.id}`)).status).toBe(404);
    } finally { clock.mockRestore(); }
  });

});
