import { expect, test } from "bun:test";
import { WatchGroupController } from "../../apps/desktop/src/main/watch-groups/WatchGroupController";
import { ServerClock } from "../../apps/desktop/src/main/watch-groups/ServerClock";
import { positionAt } from "../../packages/contracts/src";
import { FakePlayer, session } from "../helpers/group-player";
import { watchGroupSnapshot } from "../helpers/watch-groups";

test("three independent clocks converge under jitter, buffering, missing snapshots and drift without seek storms", async () => {
  const snapshot = watchGroupSnapshot();
  if (snapshot.playback.type !== "playback") return;
  const state = snapshot.playback.state;
  let serverNow = 0;
  const clients = [50_000, 300, 800_000].map((origin) => {
    const player = new FakePlayer();
    player.now = origin;
    const clock = new ServerClock();
    const probes = () => {
      for (let i = 0; i < 4; i++) {
        const delay = i === 3 ? 120 : 5 + i;
        const probe = crypto.randomUUID();
        clock.begin(probe, origin + serverNow);
        clock.receive(
          probe,
          serverNow + delay,
          serverNow + delay + 3,
          origin + serverNow + 2 * delay + 3,
        );
      }
    };
    probes();
    const controller = new WatchGroupController({
      player,
      acquire: async () => session,
      release: async () => {},
      now: () => player.now,
      clock: (now) => clock.estimate(now),
      onStatus: () => {},
    });
    controller.setConnected(true);
    controller.update(snapshot);
    return { player, controller, probes, origin };
  });
  await Promise.all(clients.map((client) => client.controller.tick()));
  const [behind, ahead, far] = clients;
  if (behind === undefined || ahead === undefined || far === undefined)
    throw new Error("Missing desktop");
  behind.player.position -= 0.5;
  ahead.player.position += 0.5;
  far.player.position -= 1.5;
  for (let tick = 1; tick <= 100; tick++) {
    serverNow += 250;
    for (const client of clients) {
      client.player.now = client.origin + serverNow;
      if (!client.player.paused && !client.player.buffering)
        client.player.position += 0.25 * client.player.rate;
      if (tick % 20 === 0) client.probes();
      await client.controller.tick();
    }
  }
  for (const client of clients) {
    expect(
      Math.abs(positionAt(state, serverNow) - client.player.position * 1_000),
    ).toBeLessThanOrEqual(120);
    expect(client.player.rate).toBe(1);
    expect(client.player.paused).toBe(false);
  }
  expect(behind.player.seeks.length).toBe(1);
  expect(ahead.player.seeks.length).toBe(1);
  expect(far.player.seeks.length).toBe(2);
  behind.player.buffering = true;
  for (let i = 0; i < 12; i++) {
    serverNow += 250;
    behind.player.now += 250;
    await behind.controller.tick();
  }
  expect(behind.player.seeks.length).toBe(1);
  behind.player.buffering = false;
  behind.probes();
  await behind.controller.tick();
  expect(behind.player.seeks.length).toBe(2);
  const paused = {
    ...snapshot,
    playback: {
      type: "playback" as const,
      state: {
        ...state,
        revision: 4,
        alignmentRevision: 3,
        mode: "paused" as const,
        anchorPositionMs: 10_100,
        anchorServerTimeMs: serverNow,
      },
    },
  };
  for (const client of clients) {
    client.player.now = client.origin + serverNow;
    client.probes();
    client.controller.update(paused);
    await client.controller.tick();
    client.controller.update({ ...paused });
    await client.controller.tick();
    expect(client.player.position).toBe(10.1);
    expect(client.player.paused).toBe(true);
  }
  await Promise.all(clients.map((client) => client.controller.dispose()));
});
