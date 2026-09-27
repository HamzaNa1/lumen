import { FakePlayer, session } from "../helpers/group-player";
import { expect, test } from "bun:test";
import { WatchGroupController } from "../../apps/desktop/src/main/watch-groups/WatchGroupController";
import { watchGroupSnapshot } from "../helpers/watch-groups";

const fixture = () => {
  const player = new FakePlayer();
  const controller = new WatchGroupController({
    player,
    acquire: async () => session,
    release: async () => {},
    now: () => player.now,
    clock: (now) => ({ serverNowMs: now, uncertaintyMs: 0, fine: true }),
    onStatus: () => {},
  });
  controller.setConnected(true);
  return { player, controller };
};
test("late join aligns after loading to the current timeline and remote operations emit no user intents", async () => {
  const { player, controller } = fixture();
  player.loading = async () => {
    player.now = 3_000;
  };
  controller.update(watchGroupSnapshot());
  await controller.tick();
  expect(player.seeks).toEqual([8]);
  expect(player.paused).toBe(false);
  expect(player.loads).toBe(1);
  await controller.dispose();
});

test("paused late joins stay paused and a coalesced seek/pause is applied once", async () => {
  const { player, controller } = fixture();
  const snapshot = watchGroupSnapshot();
  if (snapshot.playback.type !== "playback") return;
  snapshot.playback = { type: "playback", state: { ...snapshot.playback.state, mode: "paused" } };
  controller.update(snapshot);
  await controller.tick();
  expect(player.paused).toBe(true);
  expect(player.seeks).toEqual([5]);
  const sought = {
    ...snapshot,
    playback: {
      type: "playback" as const,
      state: {
        ...snapshot.playback.state,
        revision: 4,
        alignmentRevision: 3,
        anchorPositionMs: 5_100,
      },
    },
  };
  controller.update(sought);
  await controller.tick();
  controller.update({ ...sought });
  await controller.tick();
  expect(player.seeks).toEqual([5, 5.1]);
  expect(player.paused).toBe(true);
  await controller.dispose();
});

test("pause and seek during loading coalesce to the newest state", async () => {
  const { player, controller } = fixture();
  const snapshot = watchGroupSnapshot();
  if (snapshot.playback.type !== "playback") return;
  player.loading = async () => {
    player.now = 2_000;
    controller.update({
      ...snapshot,
      playback: {
        type: "playback",
        state: {
          ...snapshot.playback.state,
          revision: 3,
          alignmentRevision: 2,
          mode: "paused",
          anchorPositionMs: 7_100,
          anchorServerTimeMs: 1_000,
        },
      },
    });
  };
  controller.update(snapshot);
  await controller.tick();
  expect(player.loads).toBe(1);
  expect(player.seeks).toEqual([7.1]);
  expect(player.paused).toBe(true);
  await controller.dispose();
});

test("stop during delayed session allocation releases the stale personal grant without loading", async () => {
  const player = new FakePlayer();
  const snapshot = watchGroupSnapshot();
  if (snapshot.playback.type !== "playback") return;
  const state = snapshot.playback.state;
  let released = 0;
  const controller = new WatchGroupController({
    player,
    now: () => player.now,
    clock: (now) => ({ serverNowMs: now, uncertaintyMs: 0, fine: true }),
    onStatus: () => {},
    release: async () => {
      released++;
    },
    acquire: async () => {
      controller.update({
        ...snapshot,
        playback: {
          type: "playback",
          state: {
            ...state,
            revision: 2,
            playbackId: crypto.randomUUID(),
            mode: "stopped",
            media: null,
            anchorPositionMs: 0,
          },
        },
      });
      return session;
    },
  });
  controller.setConnected(true);
  controller.update(snapshot);
  await controller.tick();
  expect(player.loads).toBe(0);
  expect(released).toBe(1);
  expect(player.seeks).toEqual([]);
  await controller.dispose();
});

test("buffering and EOF suspend corrections; disconnect restores rate and pauses locally", async () => {
  const { player, controller } = fixture();
  const snapshot = watchGroupSnapshot();
  controller.update(snapshot);
  await controller.tick();
  player.now = 2_000;
  player.position = 6.5;
  await controller.tick();
  expect(player.rate).toBe(1.05);
  player.buffering = true;
  await controller.tick();
  expect(player.rate).toBe(1);
  player.buffering = false;
  player.ended = true;
  player.now = 5_000;
  await controller.tick();
  expect(player.seeks.length).toBe(1);
  controller.setConnected(false);
  await controller.tick();
  expect(player.paused).toBe(true);
  expect(player.rate).toBe(1);
  await controller.dispose();
});

test("repeated local loading failures stop retrying after three attempts", async () => {
  const { player, controller } = fixture();
  player.loading = async () => {
    throw new Error("Native player failed");
  };
  controller.update(watchGroupSnapshot());
  for (let i = 0; i < 10; i++) {
    player.now += 10_000;
    await controller.tick();
  }
  expect(player.loads).toBe(3);
  await controller.dispose();
});

test("a stop interrupts an in-flight native load immediately", async () => {
  const player = new FakePlayer();
  const initial = watchGroupSnapshot();
  if (initial.playback.type !== "playback") return;
  let started = () => {};
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  player.loadPaused = async (_session, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("Cancelled"));
        },
        { once: true },
      );
    });
  };
  const controller = new WatchGroupController({
    player,
    acquire: async () => session,
    release: async () => {},
    now: () => 0,
    clock: () => ({ serverNowMs: 0, uncertaintyMs: 0, fine: true }),
    onStatus: () => {},
  });
  controller.setConnected(true);
  controller.update(initial);
  await loading;
  controller.update({
    ...initial,
    playback: {
      type: "playback",
      state: {
        ...initial.playback.state,
        revision: 2,
        playbackId: crypto.randomUUID(),
        mode: "stopped",
        media: null,
        anchorPositionMs: 0,
      },
    },
  });
  await controller.tick();
  expect(aborted).toBe(true);
  expect(player.paused).toBe(true);
  await controller.dispose();
});

test("reconnect and an expired personal grant obtain a fresh alignment", async () => {
  const { player, controller } = fixture();
  controller.update(watchGroupSnapshot());
  await controller.tick();
  controller.setConnected(false);
  await controller.tick();
  player.now = 5_000;
  controller.setConnected(true);
  await controller.tick();
  expect(player.seeks).toEqual([5, 10]);
  expect(player.loads).toBe(1);
  controller.renewSession();
  await controller.tick();
  expect(player.loads).toBe(2);
  expect(player.seeks).toEqual([5, 10, 10]);
  await controller.dispose();
});
