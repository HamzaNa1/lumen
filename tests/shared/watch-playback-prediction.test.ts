import { expect, test } from "bun:test";
import type { WatchAction, WatchGroup, WatchMessage } from "@lumen/contracts";
import {
  WatchPlaybackController,
  type WatchPlayer,
  type WatchServer,
} from "../../packages/client/src/index.ts";
import { eventually } from "../helpers/eventually";

const fixture = async (group: WatchGroup) => {
  const requests: { requestId: string; action: WatchAction }[] = [];
  let publish: (message: WatchMessage) => void = () => {
    throw new Error("Socket is not connected");
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        publish = (message) => {
          socket.send(JSON.stringify(message));
        };
      },
      message(_socket, raw) {
        const request = JSON.parse(String(raw)) as { requestId: string; action?: WatchAction };
        if (request.action === undefined) {
          publish({ type: "ready", memberId: crypto.randomUUID(), displayName: "Viewer" });
          publish({ type: "state", group });
        } else if (request.action.type === "ping") {
          publish({ type: "pong", sentAtMs: request.action.sentAtMs, serverTimeMs: Date.now() });
          publish({ type: "reply", requestId: request.requestId, error: null });
        } else requests.push({ requestId: request.requestId, action: request.action });
      },
    },
  });
  let state: ReturnType<WatchPlayer<WatchServer>["getState"]> = null;
  let startGate: Promise<void> | null = null;
  const starts: string[] = [];
  let seeks = 0;
  let completedStarts = 0;
  const player: WatchPlayer<WatchServer> = {
    start: async ({ itemId, startAtSeconds, paused }) => {
      starts.push(itemId);
      await startGate;
      state = {
        sessionId: crypto.randomUUID(),
        itemId,
        positionSeconds: startAtSeconds ?? 0,
        paused: paused ?? false,
        durationSeconds: 100,
      };
      completedStarts += 1;
    },
    stop: async () => {
      state = null;
    },
    getState: () => state,
    sample: () => state === null ? null : { ...state, sampledAtMs: performance.now(), speed: 1, advancing: !state.paused },
    seek: async (_sessionId, positionSeconds) => {
      seeks += 1;
      if (state !== null) state = { ...state, positionSeconds };
    },
    pause: async (_sessionId, paused) => {
      if (state !== null) state = { ...state, paused };
    },
    speed: async () => {},
    buffer: () => ({ aheadSeconds: Infinity, starved: false, settled: false }),
  };
  const controller = new WatchPlaybackController(player, () => {});
  controller.setSurfaceReady(true);
  controller.connect(
    {
      serverOrigin: server.url.toString(),
      watchAuthentication: () => ({ token: "test" }),
      supportsWatchGroups: true,
    },
    "connection",
  );
  await eventually(() => controller.status.group !== null);
  return {
    controller,
    player,
    requests,
    starts,
    get seeks() {
      return seeks;
    },
    get completedStarts() {
      return completedStarts;
    },
    reply: (error: string | null) => {
      const request = requests.find(({ action }) => action.type === "play");
      if (request === undefined) throw new Error("No play request received");
      publish({ type: "reply", requestId: request.requestId, error });
    },
    publish: (message: WatchMessage) => publish(message),
    holdStart: (gate: Promise<void>) => {
      startGate = gate;
    },
    close: async () => {
      controller.close();
      await server.stop(true);
    },
  };
};

const emptyGroup = (): WatchGroup => ({
  id: crypto.randomUUID(),
  name: "Movie night",
  hasPassword: false,
  members: [],
  playback: null,
  revision: 0,
});

for (const switching of [false, true]) {
  test(`optimistic ${switching ? "item switch" : "first play"} loads immediately and restores playback on rejection`, async () => {
    const group = emptyGroup();
    const previous: WatchGroup = switching
      ? {
          ...group,
          revision: 3,
          playback: {
            itemId: crypto.randomUUID(),
            title: "Previous",
            positionSeconds: 7,
            paused: true,
            updatedAtMs: Date.now(),
          },
        }
      : group;
    const f = await fixture(previous);
    try {
      if (switching)
        await eventually(() => f.player.getState()?.itemId === previous.playback?.itemId);
      const itemId = crypto.randomUUID();
      const result = f.controller
        .action({ type: "play", itemId, title: "Next", positionSeconds: 20 })
        .catch((error: unknown) => error);
      expect(f.controller.status.group?.playback).toMatchObject({
        itemId,
        title: "Next",
        waitingFor: [],
      });
      await eventually(() => f.player.getState()?.itemId === itemId && f.requests.length > 0);
      expect(f.player.getState()?.paused).toBe(true);
      f.reply("Cannot control playback");
      expect(await result).toBeInstanceOf(Error);
      expect(f.controller.status.group).toEqual(previous);
      await eventually(() =>
        switching
          ? f.player.getState()?.itemId === previous.playback?.itemId
          : f.player.getState() === null,
      );
    } finally {
      await f.close();
    }
  });
}

test("a rejected first play also stops a start that completes after rejection", async () => {
  const f = await fixture(emptyGroup());
  let release!: () => void;
  f.holdStart(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const result = f.controller
      .action({ type: "play", itemId: crypto.randomUUID(), title: "Next", positionSeconds: 0 })
      .catch((error: unknown) => error);
    await eventually(() => f.starts.length > 0 && f.requests.length > 0);
    f.reply("Cannot control playback");
    expect(await result).toBeInstanceOf(Error);
    release();
    await eventually(() => f.completedStarts === 1 && f.player.getState() === null);
  } finally {
    release();
    await f.close();
  }
});

test("server confirmation supplies the canonical title without restarting or seeking again", async () => {
  const group = emptyGroup();
  const f = await fixture(group);
  try {
    const itemId = crypto.randomUUID();
    const result = f.controller.action({
      type: "play",
      itemId,
      title: "Cached title",
      positionSeconds: 20,
    });
    await eventually(() => f.seeks === 1 && f.requests.length > 0);
    f.publish({
      type: "state",
      group: {
        ...group,
        revision: 1,
        playback: {
          itemId,
          title: "Canonical title",
          positionSeconds: 20,
          paused: true,
          waitingFor: [],
          updatedAtMs: Date.now(),
        },
      },
    });
    f.reply(null);
    await result;
    expect(f.controller.status.group?.playback?.title).toBe("Canonical title");
    expect(f.starts).toEqual([itemId]);
    expect(f.seeks).toBe(1);
  } finally {
    await f.close();
  }
});
