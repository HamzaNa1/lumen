import { expect, spyOn, test } from "bun:test";
import {
  WatchPlaybackController,
  PlaybackDiagnostics,
  type WatchPlayer,
  type WatchPlayerState,
  type WatchPlaybackSample,
} from "../../packages/client/src/index.ts";
import type { WatchAction, WatchGroup } from "../../packages/contracts/src/index.ts";

/** Drive the actual controller without network or wall-clock timers. */
const runController = async (run: (fixture: ReturnType<typeof fixture>) => Promise<void>) => {
  const f = fixture();
  const clock = spyOn(performance, "now").mockImplementation(() => f.now);
  try {
    await run(f);
  } finally {
    f.controller.close();
    await f.flush();
    clock.mockRestore();
  }
};

const fixture = () => {
  let now = 10_000;
  let position = 10;
  let rate = 1;
  let session = "session";
  let paused = false;
  let starved = false;
  let ended = false;
  let sampleAge = 10;
  let cachedAge = 240;
  let bufferDelay = 0;
  let sampleDelay = 0;
  let missingSample = false;
  let failSpeed = false;
  let speedGate: Promise<void> | null = null;
  let sampleGate: Promise<void> | null = null;
  const diagnostics = new PlaybackDiagnostics();
  const rates: number[] = [];
  const actions: WatchAction[] = [];
  const seeks: number[] = [];
  const advance = (ms: number) => {
    if (!paused && !starved && !ended) position += (ms * rate) / 1000;
    now += ms;
  };
  const group: WatchGroup = {
    id: "group",
    name: "Test",
    hasPassword: false,
    members: [],
    revision: 1,
    playback: { itemId: "item", title: "Test", paused: false, positionSeconds: 0, updatedAtMs: 0 },
  };
  const state = (): WatchPlayerState => ({
    sessionId: session,
    itemId: "item",
    paused,
    durationSeconds: 1000,
    positionSeconds: position - (paused || starved ? 0 : (cachedAge * rate) / 1000),
  });
  const player: WatchPlayer = {
    getState: state,
    recordSynchronization: (fields) => diagnostics.record("watch_synchronization", fields),
    start: async () => {},
    stop: async () => {
      paused = true;
      rate = 1;
    },
    seek: async (_id, target) => {
      seeks.push(target);
      position = target;
    },
    pause: async (_id, value) => {
      paused = value;
    },
    speed: async (_id, value) => {
      const gate = speedGate;
      speedGate = null;
      await gate;
      if (failSpeed) {
        failSpeed = false;
        throw new Error("Speed unavailable");
      }
      rates.push(value);
      rate = value;
    },
    buffer: () => {
      advance(bufferDelay);
      return { aheadSeconds: 10, starved, settled: false };
    },
    sample: async () => {
      const gate = sampleGate;
      sampleGate = null;
      await gate;
      if (missingSample) return null;
      const result: WatchPlaybackSample = {
        ...state(),
        positionSeconds: position - (paused || starved || ended ? 0 : (sampleAge * rate) / 1000),
        speed: rate,
        advancing: !paused && !starved && !ended,
        sampledAtMs: now - sampleAge,
      };
      advance(sampleDelay);
      return result;
    },
  };
  const controller = new WatchPlaybackController(player, () => {});
  clearInterval(Reflect.get(controller, "timer"));
  controller.status = {
    connection: "connected",
    memberId: "member",
    groups: [],
    group,
    error: null,
  };
  const client = {
    get serverNow() {
      return now;
    },
    waitsForBuffering: true,
    action: async (action: WatchAction) => {
      actions.push(action);
      if (action.type === "leave") controller.status = { ...controller.status, group: null };
    },
    close: () => {},
    resume: () => {},
  };
  Reflect.set(controller, "client", client);
  Reflect.set(controller, "server", {});
  Reflect.set(controller, "connectionId", "connection");
  Reflect.set(controller, "surfaceReady", true);
  Reflect.set(controller, "appliedGroup", group.id);
  Reflect.set(controller, "appliedRevision", group.revision);
  const synchronize = () =>
    (Reflect.get(controller, "synchronize") as () => Promise<void>).call(controller);
  return {
    controller,
    diagnostics,
    group,
    actions,
    rates,
    seeks,
    synchronize,
    advance,
    async tick(ms = 500) {
      advance(ms);
      await synchronize();
    },
    async flush() {
      await (Reflect.get(controller, "speedQueue") as Promise<void>).catch(() => {});
    },
    get now() {
      return now;
    },
    get rate() {
      return rate;
    },
    get position() {
      return position;
    },
    offset(seconds: number) {
      position += seconds;
    },
    replace() {
      session = "replacement";
      rate = 1;
    },
    set sampleAge(value: number) {
      sampleAge = value;
    },
    set cachedAge(value: number) {
      cachedAge = value;
    },
    set bufferDelay(value: number) {
      bufferDelay = value;
    },
    set sampleDelay(value: number) {
      sampleDelay = value;
    },
    set paused(value: boolean) {
      paused = value;
    },
    set starved(value: boolean) {
      starved = value;
    },
    set ended(value: boolean) {
      ended = value;
    },
    set missingSample(value: boolean) {
      missingSample = value;
    },
    set failSpeed(value: boolean) {
      failSpeed = value;
    },
    set speedGate(value: Promise<void>) {
      speedGate = value;
    },
    set sampleGate(value: Promise<void>) {
      sampleGate = value;
    },
  };
};

test("stale UI positions and delayed buffer IPC cannot manufacture drift or oscillations", () =>
  runController(async (f) => {
    f.bufferDelay = 310;
    for (let i = 0; i < 100; i++) {
      f.cachedAge = i % 10 < 5 ? 240 : 10;
      f.sampleAge = i % 10 < 5 ? 40 : 10;
      f.sampleDelay = 35;
      await f.tick([410, 530, 800][i % 3]);
    }
    expect(f.rates).toEqual([1]);
    expect(f.seeks).toEqual([]);
  }));

test.each([-1, 1])(
  "the controller uses the measured rate to converge and settle (direction %s)",
  (direction) =>
    runController(async (f) => {
      f.offset(-direction * 0.4);
      f.sampleAge = 240;
      for (let i = 0; i < 240; i++) await f.tick(i % 2 === 0 ? 450 : 620);
      expect(f.rates).toContain(1 + direction * 0.01);
      expect(f.rate).toBe(1);
      expect(Math.abs(f.position - f.now / 1000)).toBeLessThanOrEqual(0.05);
      expect(f.seeks).toEqual([]);
    }),
);

const correcting = async (f: ReturnType<typeof fixture>) => {
  f.offset(-0.4);
  for (let i = 0; i < 4; i++) await f.tick();
  expect(f.rate).toBe(1.01);
};

test.each([
  "disconnect",
  "leave",
  "stop",
  "pause",
  "starvation",
  "end",
  "missing",
  "stale",
  "replacement",
  "failure",
  "surface",
  "resume",
  "offline",
  "group-stop",
])("correction resets on %s", (event) =>
  runController(async (f) => {
    await correcting(f);
    const playback = f.group.playback;
    if (playback === null) throw new Error("Missing group playback");
    switch (event) {
      case "disconnect":
        f.controller.disconnect();
        await f.flush();
        break;
      case "leave":
        await f.controller.action({ type: "leave" });
        break;
      case "stop":
        await f.controller.stop();
        break;
      case "pause":
        f.controller.status = {
          ...f.controller.status,
          group: { ...f.group, revision: 2, playback: { ...playback, paused: true } },
        };
        await f.tick();
        break;
      case "starvation":
        f.starved = true;
        await f.tick();
        expect(f.actions.some((action) => action.type === "buffering")).toBe(true);
        break;
      case "end":
        f.ended = true;
        await f.tick();
        break;
      case "missing":
        f.missingSample = true;
        await f.tick();
        break;
      case "stale":
        f.sampleDelay = 300;
        await f.tick();
        break;
      case "replacement":
        f.replace();
        await f.tick();
        break;
      case "surface":
        f.controller.setSurfaceReady(false);
        await f.flush();
        break;
      case "resume":
        f.controller.resume();
        await f.flush();
        break;
      case "offline":
        f.controller.status = { ...f.controller.status, connection: "offline" };
        await f.tick();
        break;
      case "group-stop":
        f.controller.status = {
          ...f.controller.status,
          group: { ...f.group, revision: 2, playback: null },
        };
        await f.tick();
        break;
      case "failure":
        f.controller.playerFailed(new Error("Decode failed"));
        await f.flush();
        break;
    }
    expect(f.rate).toBe(1);
  }),
);

test("a pending speed command is followed by a serialized reset on disconnect", () =>
  runController(async (f) => {
    f.offset(-0.4);
    for (let i = 0; i < 3; i++) await f.tick();
    let release = () => {};
    f.speedGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    f.controller.disconnect();
    release();
    await pending;
    await f.flush();
    expect(f.rates.slice(-2)).toEqual([1.01, 1]);
  }));

test("replacement during sample IPC discards the answer and resets the successor", () =>
  runController(async (f) => {
    await correcting(f);
    let release = () => {};
    f.sampleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    f.replace();
    release();
    await pending;
    expect(f.rate).toBe(1);
    expect(f.seeks).toEqual([]);
  }));

test("failed speed changes are retried at 1x and do not suppress future resets", () =>
  runController(async (f) => {
    await correcting(f);
    f.failSpeed = true;
    f.controller.disconnect();
    await f.flush();
    await f.synchronize();
    expect(f.rate).toBe(1);
  }));

test("explicit seeks and pauses proceed immediately when drift measurements are unavailable", () =>
  runController(async (f) => {
    await correcting(f);
    f.missingSample = true;
    f.controller.status = {
      ...f.controller.status,
      group: {
        ...f.group,
        revision: 2,
        playback: {
          itemId: "item",
          title: "Test",
          positionSeconds: 50,
          paused: true,
          updatedAtMs: f.now,
        },
      },
    };
    await f.synchronize();
    expect(f.seeks).toEqual([50]);
    expect(f.rate).toBe(1);
    expect(f.position).toBe(50);
  }));

test("diagnostic history stays bounded and includes sample age, measured rate and drift", () =>
  runController(async (f) => {
    for (let i = 0; i < 400; i++) await f.tick(1000);
    const history = f.diagnostics.snapshot();
    expect(history.length).toBeLessThanOrEqual(256);
    expect(history.at(-1)?.fields).toMatchObject({
      event: "drift_sample",
      sampleAgeMs: 10,
      measuredSpeed: 1,
      chosenSpeed: 1,
      advancing: true,
    });
    expect(Math.abs(Number(history.at(-1)?.fields.driftSeconds))).toBeLessThan(0.001);
  }));
