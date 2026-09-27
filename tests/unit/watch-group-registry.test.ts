import { expect, test } from "bun:test";
import {
  GroupRegistry,
  type GroupPeer,
} from "../../apps/server/src/features/watch-groups/GroupRegistry";
import { defaultWatchGroupLimits } from "../../apps/server/src/features/watch-groups/WatchGroupLimits";
import type {
  GroupCommand,
  GroupMedia,
  GroupSnapshot,
  GroupServerFrame,
} from "../../packages/contracts/src";
import type { AuthPrincipal } from "../../apps/server/src/services/AuthService";
const id = () => crypto.randomUUID();
const principal = (): AuthPrincipal => ({
  sessionId: id(),
  deviceId: id(),
  user: {
    id: id(),
    username: "viewer",
    displayName: "Viewer",
    role: "user",
    isActive: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
});
const fixture = () => {
  let now = 0;
  let allowed = true;
  const media: GroupMedia = {
    itemId: id(),
    trackId: id(),
    sourceId: id(),
    sourceGeneration: 5,
    durationMs: 600_000,
  };
  const registry = new GroupRegistry({
    limits: { ...defaultWatchGroupLimits, members: 2, groups: 2 },
    now: () => now,
    validate: async (p) => p,
    resolve: async () => media,
    canPlay: async () => allowed,
    startSession: async () => {
      throw new Error("unused");
    },
    closeSession: async () => {},
    log: () => {},
  });
  const peer = () => {
    const frames: GroupServerFrame[] = [];
    const connection: GroupPeer = {
      id: id(),
      send: (frame) => frames.push(frame),
      close: (code) => frames.push({ protocolVersion: 1, type: "membership-ended", code }),
    };
    return { connection, frames };
  };
  return {
    registry,
    media,
    peer,
    advance: (ms: number) => {
      now += ms;
    },
    deny: () => {
      allowed = false;
    },
  };
};
const command = (snapshot: GroupSnapshot, action: GroupCommand["action"]): GroupCommand => ({
  protocolVersion: 1,
  commandId: id(),
  expectedRevision:
    snapshot.playback.type === "playback"
      ? snapshot.playback.state.revision
      : snapshot.playback.revision,
  expectedPlaybackId:
    snapshot.playback.type === "playback"
      ? snapshot.playback.state.playbackId
      : snapshot.playback.playbackId,
  action,
});

test("last disconnect freezes playback, reconnect grace expires, and empty rooms are swept", async () => {
  const f = fixture();
  const user = principal();
  const group = await f.registry.create(user, { name: "Movie", idempotencyKey: id() });
  const peer = f.peer();
  await f.registry.attach((await f.registry.ticket(user, group.groupId)).ticket, peer.connection);
  await f.registry.command(
    group.groupId,
    group.membershipId,
    peer.connection.id,
    command(group, { type: "start", itemId: f.media.itemId, positionMs: 2_000 }),
  );
  f.advance(3_000);
  await f.registry.detach(group.groupId, group.membershipId, peer.connection.id);
  f.advance(2_000);
  const paused = await f.registry.state(user, group.groupId);
  expect(paused.playback).toMatchObject({ state: { mode: "paused", anchorPositionMs: 5_000 } });
  f.advance(30_000);
  await f.registry.sweep();
  await expect(f.registry.ticket(user, group.groupId)).rejects.toThrow("expired");
  f.advance(300_000);
  await f.registry.sweep();
  expect(f.registry.list(100, null).groups).toEqual([]);
  await f.registry.dispose();
});

test("concurrent controls serialize with one winner; duplicates retain outcome but permissions are fresh", async () => {
  const f = fixture();
  const first = principal();
  const second = principal();
  const group = await f.registry.create(first, { name: "Together", idempotencyKey: id() });
  const joined = await f.registry.join(second, group.groupId);
  const a = f.peer();
  const b = f.peer();
  await f.registry.attach((await f.registry.ticket(first, group.groupId)).ticket, a.connection);
  await f.registry.attach((await f.registry.ticket(second, group.groupId)).ticket, b.connection);
  const start = command(group, { type: "start", itemId: f.media.itemId, positionMs: 0 });
  const [winner, conflict] = await Promise.all([
    f.registry.command(group.groupId, group.membershipId, a.connection.id, start),
    f.registry.command(
      group.groupId,
      joined.membershipId,
      b.connection.id,
      command(group, { type: "stop" }),
    ),
  ]);
  expect(winner.outcome).toBe("accepted");
  expect(conflict.code).toBe("stale_state");
  f.deny();
  const duplicate = await f.registry.command(
    group.groupId,
    group.membershipId,
    a.connection.id,
    start,
  );
  expect(duplicate.revision).toBe(1);
  expect(duplicate.outcome).toBe("accepted");
  expect(duplicate.snapshot.playback.type).toBe("playback-access-denied");
  expect(JSON.stringify(duplicate)).not.toContain(f.media.itemId);
  await f.registry.dispose();
});

test("membership capacity and conflicting devices reject before altering existing groups", async () => {
  const f = fixture();
  const first = principal();
  const second = principal();
  const third = principal();
  const group = await f.registry.create(first, { name: "Full", idempotencyKey: id() });
  await f.registry.join(second, group.groupId);
  await expect(f.registry.join(third, group.groupId)).rejects.toThrow("full");
  await expect(
    f.registry.create(first, { name: "Duplicate", idempotencyKey: id() }),
  ).rejects.toThrow("Leave");
  const other = await f.registry.create(third, { name: "Other", idempotencyKey: id() });
  expect(other.groupId).not.toBe(group.groupId);
  await expect(
    f.registry.create(principal(), { name: "Excess", idempotencyKey: id() }),
  ).rejects.toThrow("limit");
  expect((await f.registry.state(first, group.groupId)).members.length).toBe(2);
  await f.registry.dispose();
});
