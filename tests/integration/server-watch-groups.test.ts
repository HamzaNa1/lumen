import {
  defaultWatchGroupLimits,
  type WatchGroupLimits,
} from "../../apps/server/src/features/watch-groups/WatchGroupLimits";
import { Database as Sqlite } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "../../packages/contracts/node_modules/effect/dist/index.js";
import {
  GroupServerFrame,
  type GroupCommand,
  type GroupSnapshot,
} from "../../packages/contracts/src";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";
import { seedPlayback } from "../helpers/playback";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const id = () => crypto.randomUUID();
const setup = async (limits: Partial<WatchGroupLimits> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-groups-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "server.sqlite");
  const seeded = await seedPlayback(root, databasePath);
  const server = await startServer({
    databasePath,
    dataDir: root,
    port: 0,
    watchGroups: { ...defaultWatchGroupLimits, ...limits },
  });
  cleanups.push(() => server.stop());
  const client = async (username = "admin", register = false) => {
    const deviceId = id();
    const response = await fetch(
      new URL(`/api/v1/auth/${register ? "register" : "login"}`, server.server.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          displayName: username,
          password: "correct horse battery staple",
          deviceId,
          deviceName: username,
          platform: "desktop",
          platformDeviceId: deviceId,
        }),
      },
    );
    expect(response.status).toBe(register ? 201 : 200);
    const { accessToken } = (await response.json()) as { accessToken: string };
    return (path: string, method = "GET", data?: unknown) =>
      fetch(new URL(`/api/v1/${path}`, server.server.url), {
        method,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
  };
  return { seeded, server, client, databasePath };
};
type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["client"]>>;
const socket = async (server: RunningServer, client: Client, groupId: string) => {
  const response = await client(`watch-groups/${groupId}/connection-tickets`, "POST", {});
  expect(response.status).toBe(200);
  const { ticket } = (await response.json()) as { ticket: string };
  const url = new URL("/api/v1/watch-groups/socket", server.server.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  const frames: GroupServerFrame[] = [];
  const waiters = new Set<() => void>();
  ws.onmessage = (event) => {
    frames.push(Schema.decodeUnknownSync(GroupServerFrame)(JSON.parse(String(event.data))));
    for (const wake of waiters) wake();
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Socket failed"));
  });
  const next = (predicate: (frame: GroupServerFrame) => boolean): Promise<GroupServerFrame> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Missing frame: ${JSON.stringify(frames)}`));
      }, 3_000);
      const check = () => {
        const index = frames.findIndex(predicate);
        if (index < 0) return;
        const frame = frames.splice(index, 1)[0];
        if (frame === undefined) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(frame);
      };
      waiters.add(check);
      check();
    });
  ws.send(JSON.stringify({ protocolVersion: 1, type: "authenticate", ticket }));
  const initial = await next((f) => f.type === "snapshot");
  cleanups.push(async () => {
    ws.close();
  });
  return {
    ws,
    next,
    initial,
    ticket,
    send: (command: GroupCommand) =>
      ws.send(JSON.stringify({ protocolVersion: 1, type: "command", command })),
  };
};
const command = (snapshot: GroupSnapshot, action: GroupCommand["action"]): GroupCommand => ({
  protocolVersion: 1,
  commandId: id(),
  expectedPlaybackId:
    snapshot.playback.type === "playback"
      ? snapshot.playback.state.playbackId
      : snapshot.playback.playbackId,
  expectedRevision:
    snapshot.playback.type === "playback"
      ? snapshot.playback.state.revision
      : snapshot.playback.revision,
  action,
});

test("authenticated members receive shared controls, stale conflicts and deduplicated results", async () => {
  const { server, client, seeded } = await setup();
  const first = await client();
  const second = await client();
  const input = { name: "Friday movie night", idempotencyKey: id() };
  const created = await first("watch-groups", "POST", input);
  expect(created.status).toBe(201);
  const group = (await created.json()) as GroupSnapshot;
  expect(
    ((await (await first("watch-groups", "POST", input)).json()) as GroupSnapshot).groupId,
  ).toBe(group.groupId);
  expect((await second(`watch-groups/${group.groupId}/memberships`, "POST", {})).status).toBe(200);
  const a = await socket(server, first, group.groupId);
  const b = await socket(server, second, group.groupId);
  const start = command(group, { type: "start", itemId: seeded.itemId, positionMs: 1_000 });
  a.send(start);
  const accepted = await a.next((f) => f.type === "command-result");
  expect(accepted.type).toBe("command-result");
  if (accepted.type !== "command-result") return;
  expect(accepted.result.outcome).toBe("accepted");
  expect(accepted.result.snapshot.playback).toMatchObject({
    type: "playback",
    state: {
      mode: "playing",
      media: { itemId: seeded.itemId, trackId: seeded.trackId, sourceGeneration: 1 },
      revision: 1,
    },
  });
  expect(
    await b.next(
      (f) =>
        f.type === "snapshot" &&
        f.snapshot.playback.type === "playback" &&
        f.snapshot.playback.state.revision === 1,
    ),
  ).toMatchObject({ type: "snapshot" });
  b.send(command(group, { type: "seek", positionMs: 5_000 }));
  expect(await b.next((f) => f.type === "command-result")).toMatchObject({
    result: { code: "stale_state", revision: 1 },
  });
  a.send(start);
  expect(await a.next((f) => f.type === "command-result")).toMatchObject({
    result: { outcome: "accepted", revision: 1 },
  });
  a.send({ ...start, action: { type: "stop" } });
  expect(await a.next((f) => f.type === "command-result")).toMatchObject({
    result: { code: "invalid_command" },
  });
  const shared = accepted.result.snapshot;
  if (shared.playback.type !== "playback") return;
  const personal = await second(`watch-groups/${group.groupId}/playback-sessions`, "POST", {
    expectedPlaybackId: shared.playback.state.playbackId,
  });
  expect(personal.status).toBe(201);
  expect(await personal.json()).toMatchObject({
    itemId: seeded.itemId,
    sourceId: shared.playback.state.media?.sourceId,
    sourceGeneration: 1,
  });
  b.send(command(shared, { type: "set-paused", paused: true }));
  expect(await b.next((f) => f.type === "command-result")).toMatchObject({
    result: { outcome: "accepted", snapshot: { playback: { state: { mode: "paused" } } } },
  });
});

test("non-admin users can create/join; protected rooms redact unauthorized media and deny grants", async () => {
  const { server, client, seeded } = await setup();
  const admin = await client();
  const user = await client("viewer", true);
  const anonymous = await fetch(new URL("/api/v1/watch-groups", server.server.url));
  expect(anonymous.status).toBe(401);
  expect(
    (
      await user("watch-groups", "POST", {
        name: "Empty password",
        password: "",
        idempotencyKey: id(),
      })
    ).status,
  ).toBe(400);
  const own = await user("watch-groups", "POST", { name: "Viewers", idempotencyKey: id() });
  expect(own.status).toBe(201);
  const ownGroup = (await own.json()) as GroupSnapshot;
  await user(`watch-groups/${ownGroup.groupId}/memberships/me`, "DELETE");
  const group = (await (
    await admin("watch-groups", "POST", {
      name: "Private screening",
      password: "friends",
      idempotencyKey: id(),
    })
  ).json()) as GroupSnapshot;
  expect(
    (await user(`watch-groups/${group.groupId}/memberships`, "POST", { password: "wrong" })).status,
  ).toBe(403);
  expect(
    (await user(`watch-groups/${group.groupId}/memberships`, "POST", { password: "friends" }))
      .status,
  ).toBe(200);
  const a = await socket(server, admin, group.groupId);
  const b = await socket(server, user, group.groupId);
  a.send(command(group, { type: "start", itemId: seeded.itemId, positionMs: 0 }));
  const blocked = await b.next(
    (f) => f.type === "snapshot" && f.snapshot.playback.type === "playback-access-denied",
  );
  expect(JSON.stringify(blocked)).not.toContain(seeded.itemId);
  expect(JSON.stringify(blocked)).not.toContain("anchorPosition");
  if (blocked.type !== "snapshot") return;
  b.send(command(blocked.snapshot, { type: "set-paused", paused: true }));
  expect(await b.next((f) => f.type === "command-result")).toMatchObject({
    result: { code: "denied" },
  });
  const playbackId =
    blocked.snapshot.playback.type === "playback-access-denied"
      ? blocked.snapshot.playback.playbackId
      : "";
  expect(
    (
      await user(`watch-groups/${group.groupId}/playback-sessions`, "POST", {
        expectedPlaybackId: playbackId,
      })
    ).status,
  ).toBe(403);
  expect(
    (await user("watch-groups", "POST", { name: "Another", idempotencyKey: id() })).status,
  ).toBe(429);
});

test("replacement sockets preserve membership; leaving freezes an empty room and invalidates tickets", async () => {
  const { server, client } = await setup();
  const user = await client();
  const group = (await (
    await user("watch-groups", "POST", { name: "Reconnect", idempotencyKey: id() })
  ).json()) as GroupSnapshot;
  const a = await socket(server, user, group.groupId);
  const b = await socket(server, user, group.groupId);
  const pongId = id();
  b.ws.send(JSON.stringify({ protocolVersion: 1, type: "clock-ping", probeId: pongId }));
  expect(await b.next((f) => f.type === "clock-pong")).toMatchObject({
    probeId: pongId,
    serverInstanceId: group.serverInstanceId,
  });
  b.send(command(group, { type: "stop" }));
  expect(await b.next((f) => f.type === "command-result")).toMatchObject({
    result: { outcome: "accepted" },
  });
  expect((await user(`watch-groups/${group.groupId}/memberships/me`, "DELETE")).status).toBe(200);
  expect((await user(`watch-groups/${group.groupId}/state`)).status).toBe(404);
  expect(a.ws.readyState).not.toBe(WebSocket.CONNECTING);
});

test("live permission changes redact cached results and revoke sockets without affecting other rooms", async () => {
  const { server, client, seeded } = await setup({ refreshMs: 40 });
  const admin = await client();
  const viewer = await client("friend", true);
  const user = (await (await viewer("auth/me")).json()) as { id: string };
  const grant = await admin(`libraries/${seeded.libraryId}/grants/${user.id}`, "PUT", {
    id: id(),
    libraryId: seeded.libraryId,
    userId: user.id,
    role: "user",
    canDownload: false,
    capabilities: ["library:read", "playback:control"],
    expiresAtMs: null,
  });
  expect(grant.status).toBe(200);
  const group = (await (
    await viewer("watch-groups", "POST", { name: "Friends", idempotencyKey: id() })
  ).json()) as GroupSnapshot;
  const a = await socket(server, viewer, group.groupId);
  const start = command(group, { type: "start", itemId: seeded.itemId, positionMs: 0 });
  a.send(start);
  expect(await a.next((f) => f.type === "command-result")).toMatchObject({
    result: { outcome: "accepted" },
  });
  const revoked = await admin(`libraries/${seeded.libraryId}/grants`, "PUT", {
    id: id(),
    libraryId: seeded.libraryId,
    userId: user.id,
    role: "user",
    canDownload: false,
    capabilities: [],
    expiresAtMs: null,
  });
  expect(revoked.status).toBe(200);
  await a.next(
    (f) => f.type === "snapshot" && f.snapshot.playback.type === "playback-access-denied",
  );
  a.send(start);
  const cached = await a.next((f) => f.type === "command-result");
  expect(cached).toMatchObject({
    result: {
      outcome: "accepted",
      revision: 1,
      snapshot: { playback: { type: "playback-access-denied" } },
    },
  });
  expect(JSON.stringify(cached)).not.toContain(seeded.itemId);
  expect((await admin(`users/${user.id}`, "PATCH", { isActive: false })).status).toBe(200);
  expect(await a.next((f) => f.type === "membership-ended")).toMatchObject({
    code: "membership_expired",
  });
});

test("ticket replay, oversized frames, unauthenticated sockets and membership bounds are enforced", async () => {
  const { server, client } = await setup({
    authenticationTimeoutMs: 60,
    members: 1,
    groups: 2,
    frameBytes: 512,
  });
  const first = await client();
  const second = await client();
  const group = (await (
    await first("watch-groups", "POST", { name: "Bounded", idempotencyKey: id() })
  ).json()) as GroupSnapshot;
  expect((await second(`watch-groups/${group.groupId}/memberships`, "POST", {})).status).toBe(429);
  const a = await socket(server, first, group.groupId);
  const url = new URL("/api/v1/watch-groups/socket", server.server.url);
  url.protocol = "ws:";
  const closed = async (frame?: string) => {
    const ws = new WebSocket(url);
    cleanups.push(async () => ws.close());
    const close = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket remained open")), 1_000);
      ws.onclose = (event) => {
        clearTimeout(timer);
        resolve(event.code);
      };
    });
    ws.onopen = () => {
      if (frame !== undefined) ws.send(frame);
    };
    return close;
  };
  expect(
    await closed(JSON.stringify({ protocolVersion: 1, type: "authenticate", ticket: a.ticket })),
  ).toBe(4000);
  expect(await closed()).toBe(4000);
  expect([1006, 1009]).toContain(await closed("x".repeat(1_000)));
  const other = (await (
    await second("watch-groups", "POST", { name: "Unaffected", idempotencyKey: id() })
  ).json()) as GroupSnapshot;
  const b = await socket(server, second, other.groupId);
  b.send(command(other, { type: "stop" }));
  expect(await b.next((f) => f.type === "command-result")).toMatchObject({
    result: { outcome: "accepted" },
  });
});

test("the exact source generation cannot silently change between group start and personal session", async () => {
  const { server, client, seeded, databasePath } = await setup();
  const user = await client();
  const group = (await (
    await user("watch-groups", "POST", { name: "Same cut", idempotencyKey: id() })
  ).json()) as GroupSnapshot;
  const a = await socket(server, user, group.groupId);
  a.send(command(group, { type: "start", itemId: seeded.itemId, positionMs: 0 }));
  const accepted = await a.next((f) => f.type === "command-result");
  if (accepted.type !== "command-result" || accepted.result.snapshot.playback.type !== "playback")
    throw new Error("Missing state");
  const playbackId = accepted.result.snapshot.playback.state.playbackId;
  const db = new Sqlite(databasePath);
  db.run("UPDATE catalog_item_sources SET source_generation = 2 WHERE item_id = ?", [
    seeded.itemId,
  ]);
  db.close();
  expect(
    (
      await user(`watch-groups/${group.groupId}/playback-sessions`, "POST", {
        expectedPlaybackId: playbackId,
      })
    ).status,
  ).toBe(404);
  const stale = await user(`watch-groups/${group.groupId}/playback-sessions`, "POST", {
    expectedPlaybackId: id(),
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: "stale_state",
    snapshot: { groupId: group.groupId },
  });
});
