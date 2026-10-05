import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { expect, test } from "bun:test";
import type { PlayerState } from "@lumen/contracts";
import { watchCorrection, watchPosition } from "../../packages/contracts/src/watch-groups";
import {
  type PlayerBuffer,
  type ServerApi,
  WatchPlaybackController,
  type WatchPlayer,
  type WatchServer,
} from "../../packages/client/src/index.ts";
import { eventually, watchFixture, watchProxy } from "../helpers/watch-groups";

class NativePlayback implements WatchPlayer<ServerApi & WatchServer> {
  state: PlayerState | null = null;
  rate = 1;
  failNextStart = false;
  async start(input: Parameters<WatchPlayer<ServerApi & WatchServer>["start"]>[0]) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("Temporary media failure");
    }
    const session = await input.server.startPlayback(input.itemId);
    this.state = {
      sessionId: session.sessionId,
      itemId: input.itemId,
      positionSeconds: input.startAtSeconds ?? 0,
      durationSeconds: 100,
      paused: input.paused ?? false,
      ended: false,
      volume: 100,
      muted: false,
      bufferedRanges: [],
      streams: [],
      selectedAudioStreamId: null,
      selectedSubtitleStreamId: null,
      audioOutput: "stereo",
    };
    return session;
  }
  async stop() {
    this.state = null;
    this.rate = 1;
  }
  getState() {
    return this.state;
  }
  seeks = 0;
  async seek(_sessionId: string, positionSeconds: number) {
    if (this.state === null) throw new Error("No media");
    this.seeks += 1;
    this.state = { ...this.state, positionSeconds };
    return this.state;
  }
  async pause(_sessionId: string, paused: boolean) {
    if (this.state === null) throw new Error("No media");
    this.state = { ...this.state, paused };
    return this.state;
  }
  async speed(_sessionId: string, speed: number) {
    this.rate = speed;
  }
  /** How far past its position the player has fetched; a group waits for five seconds. */
  aheadSeconds = Number.POSITIVE_INFINITY;
  /** Models a player that ran out of media while playing. */
  starved = false;
  /** Holds back the answer to the next `buffer()` until the test settles it. */
  bufferGate: Promise<PlayerBuffer> | null = null;
  buffer() {
    const gate = this.bufferGate;
    this.bufferGate = null;
    return gate ?? { aheadSeconds: this.aheadSeconds, starved: this.starved };
  }
}

test("a late join waits for its native surface, seeks to the shared pause position, and follows commands", async () => {
  const fixture = await watchFixture();
  const native = new NativePlayback();
  const playback = new WatchPlaybackController(native, () => undefined);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await owner.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: true,
      positionSeconds: 4.25,
    });
    playback.connect(await fixture.login(), "viewer");
    await eventually(() => playback.status.connection === "connected");
    await playback.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
    await Bun.sleep(550);
    expect(native.state).toBeNull();
    playback.setSurfaceReady(true);
    await eventually(() => native.state?.positionSeconds === 4.25);
    expect(native.state).toMatchObject({ itemId: fixture.itemId, paused: true });
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 7.75 });
    await eventually(() => native.state?.positionSeconds === 7.75);
    await owner.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: false,
      positionSeconds: 7.75,
    });
    await eventually(() => native.state?.paused === false);
    await owner.action({ type: "stop", itemId: fixture.itemId });
    await eventually(() => native.state === null);
    // Leaving /player invokes stop again after the shared state is already empty.
    await playback.stop();
    expect(playback.status.group?.id).toBe(owner.status.group?.id);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 1 });
    await eventually(() => native.state?.paused === false);
    await playback.stop();
    expect(native.state).toBeNull();
    await eventually(() => owner.status.group?.playback === null);
    await playback.stop();
    expect(playback.status.group?.id).toBe(owner.status.group?.id);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await eventually(() => native.state?.paused === false);
  } finally {
    playback.close();
    await fixture.close();
  }
});

test("a temporary native playback failure recovers without another group command", async () => {
  const fixture = await watchFixture();
  const native = new NativePlayback();
  native.failNextStart = true;
  const playback = new WatchPlaybackController(native, () => undefined);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 2 });
    playback.connect(await fixture.login(), "viewer");
    playback.setSurfaceReady(true);
    await eventually(() => playback.status.connection === "connected");
    await playback.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
    await eventually(() => playback.status.error === "Temporary media failure");
    await eventually(() => native.state?.positionSeconds === 2);
    expect(playback.status.error).toBeNull();
  } finally {
    playback.close();
    await fixture.close();
  }
});

test("small delays change speed, large delays seek, and paused playback never speeds up", () => {
  expect(watchCorrection(10, 10.5, false)).toEqual({ seek: null, speed: 1.05 });
  expect(watchCorrection(10.5, 10, false)).toEqual({ seek: null, speed: 0.95 });
  expect(watchCorrection(10, 11.2, false)).toEqual({ seek: 11.2, speed: 1 });
  expect(watchCorrection(11.2, 10, false)).toEqual({ seek: 10, speed: 1 });
  expect(watchCorrection(10, 11, false)).toEqual({ seek: 11, speed: 1 });
  expect(watchCorrection(10, 10.04, false)).toEqual({ seek: null, speed: 1 });
  expect(watchCorrection(10, 10.5, true)).toEqual({ seek: 10.5, speed: 1 });
  expect(
    watchPosition(
      { itemId: "video", title: "Movie", positionSeconds: 10, paused: false, updatedAtMs: 1000 },
      2500,
    ),
  ).toBe(11.5);
  expect(
    watchPosition(
      { itemId: "video", title: "Movie", positionSeconds: 10, paused: true, updatedAtMs: 1000 },
      2500,
    ),
  ).toBe(10);
});

test("stopping during a delayed rejoin cancels membership recovery and stays stopped", async () => {
  const fixture = await watchFixture();
  const proxy = watchProxy(fixture.running.server.url);
  const native = new NativePlayback();
  const playback = new WatchPlaybackController(native, () => undefined);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "together" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 2 });
    const server = new ServerClient({ origin: proxy.origin });
    await server.identity();
    server.setSession((await fixture.login()).currentSession);
    playback.connect(server, "viewer");
    playback.setSurfaceReady(true);
    await eventually(() => playback.status.connection === "connected");
    await playback.action({
      type: "join",
      groupId: owner.status.group?.id ?? "",
      password: "together",
    });
    await eventually(() => native.state !== null);
    proxy.overloadRejoin(300);
    await eventually(
      () =>
        playback.status.group === null &&
        playback.status.error === "Group is busy. Rejoining shortly…",
    );
    await playback.stop();
    await Bun.sleep(650);
    expect(native.state).toBeNull();
    expect(playback.status.group).toBeNull();
  } finally {
    playback.close();
    await proxy.close();
    await fixture.close();
  }
});

test("a stalled shared stop cannot delay local stop or revive playback through recovery callbacks", async () => {
  const fixture = await watchFixture();
  const proxy = watchProxy(fixture.running.server.url);
  const native = new NativePlayback();
  const playback = new WatchPlaybackController(native, () => undefined);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    const server = new ServerClient({ origin: proxy.origin });
    await server.identity();
    server.setSession((await fixture.login()).currentSession);
    playback.connect(server, "viewer");
    playback.setSurfaceReady(true);
    await eventually(() => playback.status.connection === "connected");
    await playback.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
    await eventually(() => native.state?.paused === false);
    proxy.stallStop();
    const before = Date.now();
    await playback.stop();
    expect(Date.now() - before).toBeLessThan(500);
    expect(native.state).toBeNull();
    playback.retry();
    playback.setSurfaceReady(false);
    playback.setSurfaceReady(true);
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 5 });
    await Bun.sleep(650);
    expect(native.state).toBeNull();
    expect(playback.status.error).toBeNull();
    proxy.releaseStops();
    await eventually(() => owner.status.group?.playback === null);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 6 });
    await eventually(() => native.state?.paused === false);
    expect(playback.status.group?.id).toBe(owner.status.group?.id);
    proxy.stallStop();
    await playback.stop();
    await owner.action({ type: "stop", itemId: fixture.itemId });
    await eventually(() => playback.status.group?.playback === null);
    proxy.releaseStops();
    await playback.action({ type: "ping", sentAtMs: Date.now() });
    expect(playback.status.group?.id).toBe(owner.status.group?.id);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 1 });
    await eventually(() => native.state?.paused === false);
  } finally {
    playback.close();
    await proxy.close();
    await fixture.close();
  }
});

test.each([false, true])(
  "stop cancels an unfinished native start without publishing an error or resuming it (start fails: %s)",
  async (failStart) => {
    const fixture = await watchFixture();
    const proxy = watchProxy(fixture.running.server.url);
    let releaseStart: () => void = () => undefined;
    const starting = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let enteredStart = false;
    let resumed = false;
    class DelayedPlayback extends NativePlayback {
      override async start(input: Parameters<WatchPlayer["start"]>[0]) {
        enteredStart = true;
        await starting;
        return super.start(input);
      }
      override async pause(sessionId: string, paused: boolean) {
        if (!paused) resumed = true;
        return super.pause(sessionId, paused);
      }
    }
    const native = new DelayedPlayback();
    native.failNextStart = failStart;
    const playback = new WatchPlaybackController(native, () => undefined);
    try {
      const owner = await fixture.connect(await fixture.login());
      await owner.action({ type: "create", name: "Movie night", password: "" });
      await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
      const server = new ServerClient({ origin: proxy.origin });
      await server.identity();
      server.setSession((await fixture.login()).currentSession);
      playback.connect(server, "viewer");
      playback.setSurfaceReady(true);
      await eventually(() => playback.status.connection === "connected");
      await playback.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
      await eventually(() => enteredStart);
      proxy.stallStop();
      await playback.stop();
      releaseStart();
      await Bun.sleep(650);
      expect(native.state).toBeNull();
      expect(resumed).toBe(false);
      expect(playback.status.error).toBeNull();
    } finally {
      releaseStart();
      playback.close();
      await proxy.close();
      await fixture.close();
    }
  },
);

test.each([undefined, { watchGroups: false }])(
  "compatible servers without watch-group support keep ordinary playback available",
  async (capabilities) => {
    const fixture = await watchFixture();
    let upgrades = 0;
    let identityRequests = 0;
    const oldServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.headers.get("upgrade") === "websocket") {
          upgrades += 1;
          return new Response(null, { status: 404 });
        }
        if (path === "/api/v1/server") {
          identityRequests += 1;
          return Response.json({
            serverId: "old-server",
            displayName: "Old",
            apiVersion: "1.0.0",
            capabilities,
          });
        }
        return fetch(new URL(path, fixture.running.server.url), request);
      },
    });
    const native = new NativePlayback();
    const playback = new WatchPlaybackController(native, () => undefined);
    try {
      const client = new ServerClient({ origin: oldServer.url.toString() });
      await client.identity();
      client.setSession((await fixture.login()).currentSession);
      playback.connect(client, "old");
      playback.connect(client, "old");
      playback.retry();
      playback.setSurfaceReady(true);
      expect(playback.status.connection).toBe("unavailable");
      expect(playback.grouped).toBe(false);
      await native.start({ server: client, connectionId: "old", itemId: fixture.itemId });
      await Bun.sleep(550);
      expect(native.state?.itemId).toBe(fixture.itemId);
      expect(upgrades).toBe(0);
      expect(identityRequests).toBe(1);
      expect((await (await fixture.login()).identity()).capabilities?.watchGroups).toBe(true);
    } finally {
      playback.close();
      await oldServer.stop(true);
      await fixture.close();
    }
  },
);

test("restored media visibility resumes the current revision and a new membership buffers again", async () => {
  const fixture = await watchFixture();
  const native = new NativePlayback();
  const playback = new WatchPlaybackController(native, () => undefined);
  try {
    const admin = await fixture.login();
    const user = await admin.createUser({
      username: "guest",
      displayName: "Guest",
      password: "correct horse battery staple",
      role: "user",
    });
    const grant = {
      id: crypto.randomUUID(),
      libraryId: fixture.libraryId,
      userId: user.id,
      capabilities: ["library:read", "playback:control"],
      canDownload: false,
      expiresAtMs: null,
    };
    const putGrant = (capabilities: string[]) =>
      admin.request(`/api/v1/libraries/${fixture.libraryId}/grants`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...grant, capabilities }),
      });
    await putGrant(grant.capabilities);
    const owner = await fixture.connect(admin);
    await owner.action({ type: "create", name: "Movie night", password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    playback.connect(await fixture.login("guest"), "guest");
    playback.setSurfaceReady(true);
    await eventually(() => playback.status.connection === "connected");
    await playback.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
    await eventually(() => native.state?.paused === false);
    const revision = playback.status.group?.revision;
    await putGrant([]);
    await playback.action({ type: "ping", sentAtMs: Date.now() });
    await eventually(() => native.state === null);
    expect(playback.status.group?.revision).toBe(revision);
    expect(playback.status.group?.playback).toBeNull();
    expect(playback.status.group?.id).toBe(owner.status.group?.id);
    expect(playback.status.error).toBeNull();
    // Route cleanup runs after a filtered snapshot has already stopped the player.
    await playback.stop();
    await putGrant(grant.capabilities);
    await playback.action({ type: "ping", sentAtMs: Date.now() });
    playback.setSurfaceReady(true);
    await eventually(() => native.state?.paused === false);
    expect(playback.status.group?.revision).toBe(revision);

    // A deliberate stop whose command is denied remains suppressed until the user joins anew.
    await putGrant(["library:read"]);
    await playback.stop();
    await playback.action({ type: "ping", sentAtMs: Date.now() });
    playback.retry();
    playback.setSurfaceReady(true);
    await Bun.sleep(650);
    expect(native.state).toBeNull();
    expect(playback.status.group?.playback?.itemId).toBe(fixture.itemId);
    expect(playback.status.group?.revision).toBe(revision);
    await putGrant(grant.capabilities);
    const groupId = owner.status.group?.id ?? "";
    await playback.action({ type: "leave" });
    await playback.action({ type: "join", groupId, password: "" });
    await eventually(() => native.state?.paused === false);
    expect(playback.status.group?.revision).toBe((revision ?? 0) + 2);
    expect(playback.status.error).toBeNull();
  } finally {
    playback.close();
    await fixture.close();
  }
});

const groupViewer = async (
  fixture: Awaited<ReturnType<typeof watchFixture>>,
  groupId: string,
  connectionId: string,
  native = new NativePlayback(),
) => {
  const playback = new WatchPlaybackController(native, () => undefined);
  playback.connect(await fixture.login(), connectionId);
  playback.setSurfaceReady(true);
  await eventually(() => playback.status.connection === "connected");
  await playback.action({ type: "join", groupId, password: "" });
  return { native, playback };
};

test.each([false, true])("a late join buffers before the group plays on (already held: %s)", async (held) => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    const existing = await groupViewer(fixture, groupId, "existing");
    viewers.push(existing.playback);
    existing.native.aheadSeconds = held ? 0 : 5;
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => existing.native.state?.paused === held && existing.native.seeks > 0);
    const revision = owner.status.group?.revision;
    const seeks = existing.native.seeks;

    const native = new NativePlayback();
    native.aheadSeconds = 1;
    const late = await groupViewer(fixture, groupId, "late", native);
    viewers.push(late.playback);
    await eventually(
      () =>
        owner.status.group?.playback?.waitingFor?.includes(late.playback.status.memberId ?? "") ===
        true,
    );
    await eventually(() => native.state?.paused === true);
    if (held) {
      expect(owner.status.group?.revision).toBe(revision);
      expect(existing.native.seeks).toBe(seeks);
    }
    existing.native.aheadSeconds = 5;
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 1);
    expect(owner.status.group?.playback?.waitingFor).toEqual([late.playback.status.memberId]);
    const position = owner.status.group?.playback?.positionSeconds;
    expect(position).toBeGreaterThanOrEqual(3);

    native.aheadSeconds = 4.9;
    await Bun.sleep(700);
    expect(owner.status.group?.playback?.paused).toBe(true);
    expect(existing.native.state?.paused).toBe(true);
    expect(native.state).toMatchObject({ paused: true, positionSeconds: position });

    native.aheadSeconds = 5;
    await eventually(
      () => existing.native.state?.paused === false && native.state?.paused === false,
    );
    expect(owner.status.group?.playback).toMatchObject({ paused: false, positionSeconds: position });
    expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});

test("a member that rejoins a held group reports readiness again at the same revision", async () => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    const fast = await groupViewer(fixture, groupId, "fast");
    const slow = await groupViewer(fixture, groupId, "slow");
    viewers.push(fast.playback, slow.playback);
    slow.native.aheadSeconds = 0;
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 1);
    expect(owner.status.group?.playback?.waitingFor).toEqual([slow.playback.status.memberId]);
    const revision = owner.status.group?.revision;

    await fast.playback.action({ type: "leave" });
    fast.native.aheadSeconds = 1;
    await fast.playback.action({ type: "join", groupId, password: "" });
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 2);
    expect(owner.status.group?.revision).toBe(revision);
    fast.native.aheadSeconds = 5;
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 1);
    expect(owner.status.group?.playback?.waitingFor).toEqual([slow.playback.status.memberId]);
    slow.native.aheadSeconds = 5;
    await eventually(() => fast.native.state?.paused === false && slow.native.state?.paused === false);
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});

test("a group holds until a slow viewer has loaded, without making that viewer start over", async () => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    const fast = await groupViewer(fixture, groupId, "fast");
    const slow = await groupViewer(fixture, groupId, "slow");
    viewers.push(fast.playback, slow.playback);
    slow.native.aheadSeconds = 4.9;

    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    // The fast viewer has loaded; the group goes on waiting for the slow one alone.
    await eventually(
      () =>
        owner.status.group?.playback?.waitingFor?.length === 1 &&
        owner.status.group.playback.waitingFor[0] === slow.playback.status.memberId,
    );
    await eventually(() => slow.native.state?.positionSeconds === 3);
    const held = owner.status.group;
    const seeks = slow.native.seeks;
    await Bun.sleep(700);
    expect(owner.status.group?.revision).toBe(held?.revision);
    expect(fast.native.state).toMatchObject({ paused: true, positionSeconds: 3 });
    expect(slow.native.state).toMatchObject({ paused: true, positionSeconds: 3 });
    expect(slow.native.seeks).toBe(seeks);

    slow.native.aheadSeconds = 5;
    await eventually(() => fast.native.state?.paused === false && slow.native.state?.paused === false);
    expect(owner.status.group?.playback).toMatchObject({ positionSeconds: 3, paused: false });
    expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
    // Playback starts from where both players were already waiting.
    expect(slow.native.seeks).toBe(seeks);
    expect(slow.native.state?.positionSeconds).toBe(3);
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});

test("a held group can be paused, and stops waiting for a viewer who leaves", async () => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    const fast = await groupViewer(fixture, groupId, "fast");
    const slow = await groupViewer(fixture, groupId, "slow");
    viewers.push(fast.playback, slow.playback);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => owner.status.group?.playback?.paused === false);

    // Seeking while playing holds the group at the new position.
    slow.native.aheadSeconds = 4.9;
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 40 });
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 1);
    expect(owner.status.group?.playback).toMatchObject({ positionSeconds: 40, paused: true });

    // Pausing ends the wait: the group is simply paused, whoever loads afterwards.
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 40 });
    expect(owner.status.group?.playback).toMatchObject({ positionSeconds: 40, paused: true });
    expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
    slow.native.aheadSeconds = 5;
    await Bun.sleep(300);
    expect(owner.status.group?.playback?.paused).toBe(true);

    // Resuming holds again, and asking once more to play does not cut the wait short.
    slow.native.aheadSeconds = 4.9;
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: false, positionSeconds: 40 });
    await eventually(() => owner.status.group?.playback?.waitingFor?.length === 1);
    const held = owner.status.group?.revision;
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: false, positionSeconds: 40 });
    expect(owner.status.group?.revision).toBe(held);
    expect(owner.status.group?.playback?.paused).toBe(true);

    await slow.playback.action({ type: "leave" });
    await eventually(() => fast.native.state?.paused === false);
    expect(owner.status.group?.playback).toMatchObject({ positionSeconds: 40, paused: false });
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});

test("readiness answered after the viewer changed groups does not release the new group", async () => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const first = await fixture.connect(await fixture.login());
    await first.action({ type: "create", name: "First", password: "" });
    const second = await fixture.connect(await fixture.login());
    await second.action({ type: "create", name: "Second", password: "" });
    const viewer = await groupViewer(fixture, first.status.group?.id ?? "", "viewer");
    viewers.push(viewer.playback);

    // The player is still being asked whether it has buffered the first group's position.
    const answer = Promise.withResolvers<PlayerBuffer>();
    viewer.native.bufferGate = answer.promise;
    await first.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => viewer.native.bufferGate === null);
    const held = first.status.group?.revision;

    // Meanwhile the viewer moves to a group that holds for them at the very same revision.
    await viewer.playback.action({
      type: "join",
      groupId: second.status.group?.id ?? "",
      password: "",
    });
    await second.action({ type: "play", itemId: fixture.itemId, positionSeconds: 50 });
    expect(second.status.group?.revision).toBe(held);
    expect(second.status.group?.playback?.waitingFor).toEqual([viewer.playback.status.memberId]);

    viewer.native.aheadSeconds = 0;
    answer.resolve({ aheadSeconds: 5, starved: false });
    await eventually(() => viewer.native.state?.positionSeconds === 50);
    await Bun.sleep(300);
    expect(second.status.group?.playback).toMatchObject({
      positionSeconds: 50,
      paused: true,
      waitingFor: [viewer.playback.status.memberId],
    });

    viewer.native.aheadSeconds = 5;
    await eventually(() => second.status.group?.playback?.paused === false);
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});

test("a viewer who runs out of buffered media holds the group until they have buffered enough", async () => {
  const fixture = await watchFixture();
  const viewers: WatchPlaybackController[] = [];
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    const steady = await groupViewer(fixture, groupId, "steady");
    const stalled = await groupViewer(fixture, groupId, "stalled");
    viewers.push(steady.playback, stalled.playback);
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(
      () => steady.native.state?.paused === false && stalled.native.state?.paused === false,
    );
    const playing = owner.status.group?.revision ?? 0;

    // One player stops for want of media: the group pauses where it had got to, for everyone.
    stalled.native.aheadSeconds = 0;
    stalled.native.starved = true;
    await eventually(() => owner.status.group?.playback?.paused === true);
    stalled.native.starved = false;
    await eventually(
      () =>
        owner.status.group?.playback?.waitingFor?.length === 1 &&
        owner.status.group.playback.waitingFor[0] === stalled.playback.status.memberId,
    );
    const held = owner.status.group;
    expect(held?.revision).toBe(playing + 1);
    expect(held?.playback?.positionSeconds).toBeGreaterThanOrEqual(3);
    await eventually(
      () => steady.native.state?.paused === true && stalled.native.state?.paused === true,
    );
    expect(steady.native.state?.positionSeconds).toBe(held?.playback?.positionSeconds);

    // Having some media again is not enough; the group waits for the full five seconds.
    stalled.native.aheadSeconds = 4.9;
    await Bun.sleep(700);
    expect(owner.status.group?.revision).toBe(held?.revision);
    expect(owner.status.group?.playback?.paused).toBe(true);

    stalled.native.aheadSeconds = 5;
    await eventually(
      () => steady.native.state?.paused === false && stalled.native.state?.paused === false,
    );
    expect(owner.status.group?.playback).toMatchObject({
      positionSeconds: held?.playback?.positionSeconds,
      paused: false,
    });
    expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
  } finally {
    for (const viewer of viewers) viewer.close();
    await fixture.close();
  }
});
