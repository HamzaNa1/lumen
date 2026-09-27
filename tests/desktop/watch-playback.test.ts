import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { expect, test } from "bun:test";
import type { IpcPlayerState } from "@lumen/contracts";
import { watchCorrection, watchPosition } from "../../packages/contracts/src/watch-groups";
import {
  WatchPlaybackController,
  type WatchPlayer,
} from "../../apps/desktop/src/main/watch-groups/WatchPlaybackController";
import { eventually, watchFixture, watchProxy } from "../helpers/watch-groups";

class NativePlayback implements WatchPlayer {
  state: IpcPlayerState | null = null;
  rate = 1;
  failNextStart = false;
  async start(input: Parameters<WatchPlayer["start"]>[0]) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("Temporary media failure");
    }
    const session = await input.client.startPlayback(input.itemId);
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
  async seek(_sessionId: string, positionSeconds: number) {
    if (this.state === null) throw new Error("No media");
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
