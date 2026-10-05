import { describe, expect, test } from "bun:test";
import {
  HtmlMediaPlayer,
  type MediaElementLike,
  type HtmlMediaPlayerOptions,
} from "../../apps/web/src/HtmlMediaPlayer";
import {
  PlaybackUnsupportedError,
  ServerHttpError,
  WatchPlaybackController,
} from "../../packages/client/src/index.ts";
import { DirectSource, DeliveryFailure } from "../../apps/web/src/playback/MediaSource";
import { eventually } from "../helpers/eventually";
import { watchFixture } from "../helpers/watch-groups";
import type {
  ManagedDelivery,
  PlayerSession,
  PlayerState,
} from "../../packages/contracts/src/index.ts";

type Listener = () => void;

/** A media element whose loading and autoplay outcomes the test decides. */
class FakeMedia implements MediaElementLike {
  src = "";
  currentTime = 0;
  volume = 1;
  muted = false;
  playbackRate = 1;
  duration = Number.NaN;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  /** Fetching, until the test has the browser come to rest. */
  networkState = 2;
  error: { code: number } | null = null;
  /** The one stretch of media the element holds, if any. */
  bufferedRange: readonly [number, number] | null = null;
  readonly buffered = {
    element: this as FakeMedia,
    get length(): number {
      return this.element.bufferedRange === null ? 0 : 1;
    },
    start(): number {
      return this.element.bufferedRange?.[0] ?? 0;
    },
    end(): number {
      return this.element.bufferedRange?.[1] ?? 0;
    },
  };
  sources: string[] = [];
  /** What happens when a source is loaded: metadata arrives, an error, or nothing yet. */
  loadOutcome: "loaded" | "unsupported" | "hang" = "loaded";
  playOutcome: "plays" | "blocked" = "plays";
  /** Holds back the next successful `play()` until the test lets it through. */
  playGate: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  play(): Promise<void> {
    if (this.playOutcome === "blocked")
      return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    const started = (): void => {
      this.paused = false;
      this.emit("play");
    };
    const gate = this.playGate;
    this.playGate = null;
    if (gate !== null) return gate.then(started);
    started();
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.emit("pause");
  }
  load(): void {
    if (this.src === "") return;
    this.sources.push(this.src);
    queueMicrotask(() => {
      if (this.loadOutcome === "loaded") {
        this.duration = 100;
        this.emit("loadedmetadata");
      } else if (this.loadOutcome === "unsupported") {
        this.error = { code: 4 };
        this.emit("error");
      }
    });
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  canPlayType(type: string): string {
    return type.includes("ac-3") ? "" : "probably";
  }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  fail(code: number): void {
    this.error = { code };
    this.emit("error");
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

const setup = (
  streams: PlayerSession["streams"] = [],
  options: Partial<HtmlMediaPlayerOptions> = {},
) => {
  const element = new FakeMedia();
  const calls: string[] = [];
  const states: (PlayerState | null)[] = [];
  const failures: string[] = [];
  let sessions = 0;
  const api = {
    serverOrigin: "http://lumen.test",
    heartbeatFailure: null as Error | null,
    startGate: Promise.resolve(),
    /** Holds back the next progress write until the test lets it through. */
    progressGate: null as Promise<void> | null,
    startPlayback: async (itemId: string): Promise<PlayerSession> => {
      await api.startGate;
      sessions += 1;
      calls.push(`start session-${sessions}`);
      return {
        sessionId: `session-${sessions}`,
        itemId,
        sourceId: "source",
        title: "Film",
        streamUrl: `/api/v1/media/${itemId}`,
        durationSeconds: 100,
        streams,
        grantExpiresInSeconds: 3600,
        grantToken: `grant-${sessions}`,
      };
    },
    heartbeat: async (sessionId: string) => {
      calls.push(`heartbeat ${sessionId}`);
      if (api.heartbeatFailure !== null) throw api.heartbeatFailure;
    },
    progress: async (
      sessionId: string,
      state: PlayerState,
      sequence: number,
      init?: { keepalive?: boolean },
    ) => {
      const gate = api.progressGate;
      api.progressGate = null;
      if (gate !== null) await gate;
      calls.push(
        `progress ${sessionId} @${state.positionSeconds} #${sequence}${init?.keepalive === true ? " keepalive" : ""}`,
      );
    },
    stopPlayback: async (sessionId: string, init?: { keepalive?: boolean }) => {
      calls.push(`stop ${sessionId}${init?.keepalive === true ? " keepalive" : ""}`);
    },
  };
  const player = new HtmlMediaPlayer({
    element,
    api,
    onState: (state) => states.push(state),
    onFailure: (cause) => failures.push(cause.message),
    loadTimeoutMs: 80,
    playAnswerTimeoutMs: 80,
    ...options,
  });
  return { element, api, player, calls, states, failures };
};

describe("browser playback lifecycle", () => {
  test("plays with a grant in the element's source only, and reports the session's end", async () => {
    const { element, player, calls, states } = setup();
    await player.start({ itemId: "item-1", startAtSeconds: 30 });
    expect(element.src).toBe("http://lumen.test/api/v1/media/item-1?grant=grant-1");
    expect(element.currentTime).toBe(30);
    const state = player.getState();
    expect(state).toMatchObject({ sessionId: "session-1", paused: false, positionSeconds: 30 });
    expect(JSON.stringify(states)).not.toContain("grant-1");

    element.currentTime = 42;
    await player.pause("session-1", true);
    expect(calls).toContain("progress session-1 @42 #1");
    await player.stop();
    expect(calls.slice(-2)).toEqual(["progress session-1 @42 #2", "stop session-1"]);
    expect(states.at(-1)).toBeNull();
    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
  });

  test("a file the browser cannot decode fails with a clear, non-retryable error", async () => {
    const { element, player, calls } = setup();
    element.loadOutcome = "unsupported";
    const failure = await player.start({ itemId: "item-1" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PlaybackUnsupportedError);
    expect((failure as Error).message).toContain("can’t play this file’s format");
    expect(player.getState()).toBeNull();
    // The session opened for it is closed rather than left to expire.
    expect(calls).toEqual(["start session-1", "stop session-1"]);
  });

  test("a file that never loads times out instead of loading forever", async () => {
    const { element, player, calls } = setup();
    element.loadOutcome = "hang";
    await expect(player.start({ itemId: "item-1" })).rejects.toThrow("Timed out");
    expect(calls).toEqual(["start session-1", "stop session-1"]);
  });

  test("audio the browser cannot decode is refused before anything plays silently", async () => {
    const { element, player } = setup([
      {
        id: "a",
        kind: "audio",
        ordinal: 1,
        codec: "ac3",
        language: "eng",
        title: null,
        isDefault: true,
      },
    ]);
    const failure = await player.start({ itemId: "item-1" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PlaybackUnsupportedError);
    expect((failure as Error).message).toContain("AC3 audio");
    expect(element.sources).toEqual([]);
  });

  test("blocked autoplay waits for a click instead of failing or pretending to play", async () => {
    const { element, player } = setup();
    element.playOutcome = "blocked";
    await player.start({ itemId: "item-1" });
    expect(player.getState()).toMatchObject({ paused: true, awaitingInteraction: true });
    element.playOutcome = "plays";
    await player.allowPlayback();
    expect(player.getState()).toMatchObject({ paused: false, awaitingInteraction: false });
  });

  test("a request to play the browser holds keeps nothing waiting, and is recorded once answered", async () => {
    const { element, player, states } = setup();
    let begin: () => void = () => undefined;
    element.playGate = new Promise<void>((resolve) => {
      begin = resolve;
    });
    await player.start({ itemId: "item-1" });
    expect(player.getState()).toMatchObject({ paused: true, awaitingInteraction: false });
    // Asking again while the browser holds the first request adds nothing for it to hold.
    let asked = 0;
    const play = element.play.bind(element);
    element.play = () => {
      asked += 1;
      return play();
    };
    await player.pause("session-1", false);
    expect(asked).toBe(0);

    states.length = 0;
    begin();
    await eventually(() => states.at(-1)?.paused === false);
  });

  test("a held request to play that the browser then cannot honour ends playback visibly", async () => {
    const { element, player, failures } = setup();
    let refuse: (cause: Error) => void = () => undefined;
    element.playGate = new Promise<void>((_, reject) => {
      refuse = reject;
    });
    await player.start({ itemId: "item-1" });
    refuse(Object.assign(new Error("no decoder"), { name: "NotSupportedError" }));
    await eventually(() => failures.length === 1);
    expect(failures[0]).toContain("can’t play this file’s format");
    expect(player.getState()).toBeNull();
  });

  test("rapid navigation leaves only the last session, and closes the ones it replaced", async () => {
    const { element, player, calls, states } = setup();
    const first = player.start({ itemId: "item-1" }).catch((cause: unknown) => cause);
    const second = player.start({ itemId: "item-2" }).catch((cause: unknown) => cause);
    const third = player.start({ itemId: "item-3" });
    expect(((await first) as Error).message).toBe("Playback was cancelled");
    expect(((await second) as Error).message).toBe("Playback was cancelled");
    await third;
    expect(player.getState()?.itemId).toBe("item-3");
    expect(element.src).toContain("/api/v1/media/item-3");
    const started = calls
      .filter((call) => call.startsWith("start"))
      .map((call) => call.split(" ")[1]);
    const live = player.getState()?.sessionId;
    for (const session of started.filter((id) => id !== live))
      expect(calls).toContain(`stop ${session}`);
    // No state from a replaced session is ever published.
    expect(states.every((state) => state === null || state.itemId === "item-3")).toBe(true);
  });

  test("a start replaced while its file is still loading leaves the replacement's source alone", async () => {
    const { element, player } = setup();
    element.loadOutcome = "hang";
    const first = player.start({ itemId: "item-1" }).catch((cause: unknown) => cause);
    // Let the first start reach the element before it is replaced.
    await Bun.sleep(5);
    expect(element.src).toContain("/api/v1/media/item-1");
    const second = player.start({ itemId: "item-2" });
    await Bun.sleep(5);
    expect(element.src).toContain("/api/v1/media/item-2");
    // The first start notices it was replaced and gives up; the second's source must survive.
    expect(((await first) as Error).message).toBe("Playback was cancelled");
    expect(element.src).toContain("/api/v1/media/item-2");
    element.duration = 100;
    element.emit("loadedmetadata");
    await second;
    expect(player.getState()).toMatchObject({ itemId: "item-2", paused: false });
    expect(element.src).toContain("/api/v1/media/item-2");
  });

  test("events from a stopped session cannot update the next one", async () => {
    const { element, player, states } = setup();
    await player.start({ itemId: "item-1" });
    await player.stop();
    states.length = 0;
    element.emit("timeupdate");
    element.emit("error");
    expect(states).toEqual([]);
    await expect(player.pause("session-1", true)).rejects.toThrow("not active");
  });

  test("a pause answered after its session was replaced neither publishes nor returns state", async () => {
    const { api, player, states } = setup();
    await player.start({ itemId: "item-1" });
    let answer: () => void = () => undefined;
    api.progressGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const pausing = player.pause("session-1", true).catch((cause: unknown) => cause);
    await player.start({ itemId: "item-2" });
    states.length = 0;
    answer();
    const outcome = await pausing;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("not active");
    expect(states).toEqual([]);
    expect(player.getState()).toMatchObject({ sessionId: "session-2", itemId: "item-2" });
  });

  test("playback allowed after its session was replaced publishes nothing for the old session", async () => {
    const { element, player, states } = setup();
    element.playOutcome = "blocked";
    await player.start({ itemId: "item-1" });
    element.playOutcome = "plays";
    let begin: () => void = () => undefined;
    element.playGate = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const allowing = player.allowPlayback();
    await player.start({ itemId: "item-2", paused: true });
    states.length = 0;
    begin();
    await allowing;
    expect(states.filter((state) => state?.sessionId !== "session-2")).toEqual([]);
    expect(player.getState()).toMatchObject({ sessionId: "session-2", itemId: "item-2" });
  });

  test("a session the server expired while the tab slept is reopened at the same position", async () => {
    const { element, api, player, calls } = setup();
    await player.start({ itemId: "item-1" });
    element.currentTime = 64;
    api.heartbeatFailure = new ServerHttpError("Playback session has ended", 404);
    await player.reconcile();
    api.heartbeatFailure = null;
    expect(player.getState()).toMatchObject({ sessionId: "session-2", positionSeconds: 64 });
    expect(element.src).toContain("grant=grant-2");
    expect(calls).toContain("start session-2");
    // A server that cannot be reached is not treated as an expired session.
    api.heartbeatFailure = new Error("offline");
    await player.reconcile();
    expect(player.getState()?.sessionId).toBe("session-2");
  });

  test("a session that cannot be reopened ends visibly instead of freezing", async () => {
    const { element, api, player, states, failures } = setup();
    await player.start({ itemId: "item-1" });
    api.heartbeatFailure = new ServerHttpError("Playback session has ended", 404);
    element.loadOutcome = "unsupported";
    await player.reconcile();
    expect(states.at(-1)).toBeNull();
    expect(failures).toHaveLength(1);
    expect(player.getState()).toBeNull();
  });

  test("leaving the page saves progress with requests that can outlive it", async () => {
    const { element, player, calls } = setup();
    await player.start({ itemId: "item-1" });
    element.currentTime = 12;
    player.checkpoint();
    await Bun.sleep(1);
    expect(calls.at(-1)).toBe("progress session-1 @12 #1 keepalive");
    element.currentTime = 15;
    player.leave();
    await Bun.sleep(1);
    expect(calls.slice(-2)).toEqual([
      "progress session-1 @15 #2 keepalive",
      "stop session-1 keepalive",
    ]);
    // Restored from the back/forward cache: the ended session is replaced before resuming.
    await player.reconcile();
    expect(player.getState()).toMatchObject({
      sessionId: "session-2",
      positionSeconds: 15,
      paused: false,
    });
  });

  test("a lost connection is retried a bounded number of times, then reported", async () => {
    const { element, player, failures, states } = setup();
    await player.start({ itemId: "item-1" });
    element.fail(2);
    await Bun.sleep(5);
    expect(player.getState()?.sessionId).toBe("session-2");
    element.fail(2);
    await Bun.sleep(5);
    expect(player.getState()?.sessionId).toBe("session-3");
    expect(failures).toEqual([]);
    element.fail(2);
    await Bun.sleep(5);
    expect(failures).toEqual(["The connection was lost while loading this file."]);
    expect(player.getState()).toBeNull();
    expect(states.at(-1)).toBeNull();
  });
});

test("the browser reports how far it can play on, and when it has run out", async () => {
  const { element, player } = setup();
  await player.start({ itemId: "item-1" });
  const sessionId = "session-1";
  element.currentTime = 10;
  const ahead = (): number => player.buffer(sessionId).aheadSeconds;

  expect(ahead()).toBe(0);
  element.bufferedRange = [8, 14];
  expect(ahead()).toBe(4);
  // Media held elsewhere is no help from here.
  element.bufferedRange = [11, 30];
  expect(ahead()).toBe(0);
  element.bufferedRange = [0, 30];
  element.seeking = true;
  expect(ahead()).toBe(0);
  element.seeking = false;
  element.readyState = 2;
  expect(ahead()).toBe(0);
  element.readyState = 4;
  // Close to the end there are no five seconds left to wait for.
  element.bufferedRange = [8, 100];
  element.currentTime = 97;
  expect(ahead()).toBe(Number.POSITIVE_INFINITY);
  element.bufferedRange = null;
  element.currentTime = 100;
  expect(ahead()).toBe(Number.POSITIVE_INFINITY);

  // Fetching, the browser may yet hold more. At rest it will not, unless it cannot play on at all.
  element.bufferedRange = [8, 12];
  element.currentTime = 10;
  const settled = (): boolean => player.buffer(sessionId).settled;
  expect(settled()).toBe(false);
  element.networkState = 1;
  expect(settled()).toBe(true);
  element.seeking = true;
  expect(settled()).toBe(false);
  element.seeking = false;
  element.readyState = 2;
  expect(settled()).toBe(false);
  element.readyState = 4;
  element.networkState = 2;

  expect(player.buffer(sessionId).starved).toBe(false);
  element.emit("waiting");
  expect(player.buffer(sessionId).starved).toBe(true);
  element.seeking = true;
  expect(player.buffer(sessionId).starved).toBe(false);
  element.seeking = false;
  element.emit("playing");
  expect(player.buffer(sessionId).starved).toBe(false);
});

test.each(["direct", "managed"])(
  "a %s watch-group viewer needs five playable seconds before readiness",
  async (delivery) => {
    const fixture = await watchFixture();
    const { element, player } = delivery === "managed" ? managedSetup() : setup();
    let seeks = 0;
    const viewer = new WatchPlaybackController(
      {
        start: ({ itemId, startAtSeconds, paused }) =>
          player.start({ itemId, startAtSeconds, paused }),
        stop: () => player.stop(),
        getState: () => player.getState(),
        seek: (sessionId, positionSeconds) => {
          seeks += 1;
          return player.seek(sessionId, positionSeconds);
        },
        pause: (sessionId, paused) => player.pause(sessionId, paused),
        speed: (sessionId, speed) => player.speed(sessionId, speed),
        buffer: (sessionId) => player.buffer(sessionId),
      },
      () => undefined,
    );
    try {
      const owner = await fixture.connect(await fixture.login());
      await owner.action({ type: "create", name: "Movie night", password: "" });
      viewer.connect(await fixture.login(), "browser");
      viewer.setSurfaceReady(true);
      await eventually(() => viewer.status.connection === "connected");
      await viewer.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });

      // The seek has finished, but the browser holds too little beyond where it landed.
      element.seeking = false;
      element.bufferedRange = [0, 7.9];
      await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
      await eventually(() => seeks === 1 && element.currentTime === 3);
      if (delivery === "managed") {
        element.networkState = 1;
        expect(player.buffer("session-1").settled).toBe(false);
      }
      await Bun.sleep(700);
      expect(owner.status.group?.playback).toMatchObject({
        positionSeconds: 3,
        paused: true,
        waitingFor: [viewer.status.memberId],
      });
      expect(element.paused).toBe(true);
      expect(seeks).toBe(1);

      // Enough has arrived to play on from there.
      element.bufferedRange = [0, 8];
      await eventually(() => owner.status.group?.playback?.paused === false);
      expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
      await eventually(() => !element.paused);
      // Playback starts from where the element already waits.
      expect(seeks).toBe(1);
      expect(element.currentTime).toBe(3);
    } finally {
      viewer.close();
      await fixture.close();
    }
  },
);

const readyManaged: ManagedDelivery = {
  packageId: "a".repeat(64),
  state: "ready",
  progress: 1,
  manifestUrl: "/api/v1/managed-media/track/package/index.m3u8",
  mimeType: 'video/mp4; codecs="avc1.64001e,mp4a.40.2"',
  videoStreamId: null,
  audioStreamId: null,
  unavailableReason: null,
  forwardBufferSeconds: 30,
  backBufferSeconds: 15,
  encodedWindowBytes: 1024,
};

const managedSetup = () => {
  const deliveryStatuses: unknown[] = [];
  const adapters: {
    disposed: boolean;
    initialPosition: number;
    failure: (cause: DeliveryFailure) => void;
  }[] = [];
  const fixture = setup([], {
    deliveryPreference: () => "managed",
    managedSupported: () => true,
    preparationTimeoutMs: 500,
    onDeliveryStatus: (status) => deliveryStatuses.push(status),
    sourceFactory: (_delivery, _recovery, onFailure) => {
      const state = { disposed: false, initialPosition: -1, failure: onFailure };
      adapters.push(state);
      const direct = new DirectSource(
        fixture.element,
        fixture.api.serverOrigin,
        80,
        () => new Error("failed"),
      );
      return {
        kind: "managed",
        load: async (session, position, signal) => {
          state.initialPosition = position;
          await direct.load(session, position, signal);
        },
        seek: (position) => {
          fixture.element.currentTime = position;
        },
        dispose: () => {
          state.disposed = true;
        },
      };
    },
  });
  const api = Object.assign(fixture.api, {
    preparePlayback: async (_session: string, _signal?: AbortSignal): Promise<ManagedDelivery> =>
      readyManaged,
    managedPlaybackStatus: async (): Promise<ManagedDelivery> => readyManaged,
  });
  return { ...fixture, api, deliveryStatuses, adapters };
};

describe("managed browser session ownership", () => {
  test("preparation has its own deadline and never fabricates media progress", async () => {
    const { player, api, element, calls, deliveryStatuses } = managedSetup();
    api.preparePlayback = async () => {
      await Bun.sleep(150);
      return readyManaged;
    };
    const pending = player.start({ itemId: "item", startAtSeconds: 97, paused: true });
    await Bun.sleep(100); // Past the direct media-load timeout, still preparing.
    expect(player.getState()).toBeNull();
    expect(element.sources).toEqual([]);
    expect(calls.some((call) => call.startsWith("progress"))).toBe(false);
    await pending;
    expect(player.getState()).toMatchObject({ positionSeconds: 97, paused: true });
    expect(deliveryStatuses).toContainEqual({
      phase: "managed",
      progress: 1,
      message: "Managed playback · Original quality",
    });
    await player.stop();
  });

  test("initial resume is delivered to the adapter before fragment loading", async () => {
    const { player, adapters, element } = managedSetup();
    await player.start({ itemId: "item", startAtSeconds: 97, paused: true });
    expect(adapters[0]?.initialPosition).toBe(97);
    expect(element.currentTime).toBe(97);
    await player.seek("session-1", 30);
    await player.seek("session-1", 60);
    expect(element.currentTime).toBe(60);
    await player.stop();
    expect(adapters[0]?.disposed).toBe(true);
    expect(element.listenerCount()).toBe(0);
  });

  test("stop during preparation closes its session immediately and fences a late package response", async () => {
    const { player, api, calls, adapters, deliveryStatuses } = managedSetup();
    let resolve: () => void = () => undefined;
    const gate = new Promise<void>((answer) => {
      resolve = answer;
    });
    api.preparePlayback = async () => {
      await gate;
      return readyManaged;
    };
    const pending = player.start({ itemId: "item" }).catch((cause: unknown) => cause);
    await eventually(() => calls.includes("start session-1"));
    await player.stop();
    expect(calls).toEqual(["start session-1", "stop session-1"]);
    resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(adapters).toHaveLength(0);
    expect(deliveryStatuses.at(-1)).toBeNull();
    expect(player.getState()).toBeNull();
  });

  test("managed transport exhaustion cannot reopen another session and refill its retry budget", async () => {
    const { player, adapters, calls, failures } = managedSetup();
    await player.start({ itemId: "item" });
    adapters[0]?.failure(new DeliveryFailure("transport", "Recovery exhausted"));
    await eventually(() => failures.length === 1);
    expect(calls.filter((call) => call.startsWith("start"))).toEqual(["start session-1"]);
    expect(player.getState()).toBeNull();
    expect(adapters[0]?.disposed).toBe(true);
  });

  test("one expired-grant reconciliation preserves position, pause, volume and speed", async () => {
    const { player, api, adapters, element, failures } = managedSetup();
    await player.start({ itemId: "item", startAtSeconds: 65, paused: true });
    await player.volume("session-1", 37, true);
    await player.speed("session-1", 1.05);
    api.heartbeatFailure = new ServerHttpError("Expired session", 409);
    adapters[0]?.failure(new DeliveryFailure("authorization", "Expired"));
    await eventually(() => player.getState()?.sessionId === "session-2");
    expect(player.getState()).toMatchObject({
      positionSeconds: 65,
      paused: true,
      volume: 37,
      muted: true,
    });
    expect(element.playbackRate).toBe(1.05);
    adapters[1]?.failure(new DeliveryFailure("authorization", "Expired again"));
    await eventually(() => failures.length === 1);
    expect(player.getState()).toBeNull();
  });

  test("events from destroyed adapters cannot revive or fail a replacement session", async () => {
    const { player, adapters, failures } = managedSetup();
    await player.start({ itemId: "item-1" });
    await player.start({ itemId: "item-2", paused: true });
    expect(adapters[0]?.disposed).toBe(true);
    adapters[0]?.failure(new DeliveryFailure("transport", "Late obsolete failure"));
    await Bun.sleep(5);
    expect(failures).toEqual([]);
    expect(player.getState()).toMatchObject({ itemId: "item-2", paused: true });
    await player.stop();
  });
});

/** A browser's player joined to a watch group, as the browser runtime wires the two together. */
const groupViewer = async (prepare: (element: FakeMedia) => void = () => undefined) => {
  const fixture = await watchFixture();
  const { element, player } = setup();
  element.bufferedRange = [0, 100];
  prepare(element);
  const viewer = new WatchPlaybackController(
    {
      start: ({ itemId, startAtSeconds, paused }) =>
        player.start({ itemId, startAtSeconds, paused }),
      stop: () => player.stop(),
      getState: () => player.getState(),
      seek: (sessionId, positionSeconds) => player.seek(sessionId, positionSeconds),
      pause: (sessionId, paused) => player.pause(sessionId, paused),
      speed: (sessionId, speed) => player.speed(sessionId, speed),
      buffer: (sessionId) => player.buffer(sessionId),
    },
    () => undefined,
  );
  const owner = await fixture.connect(await fixture.login());
  await owner.action({ type: "create", name: "Movie night", password: "" });
  viewer.connect(await fixture.login(), "browser");
  viewer.setSurfaceReady(true);
  await eventually(() => viewer.status.connection === "connected");
  await viewer.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
  return {
    fixture,
    element,
    player,
    viewer,
    owner,
    async close() {
      viewer.close();
      await fixture.close();
    },
  };
};

test("a browser that holds playback back for a click joins the group's playback once clicked", async () => {
  const group = await groupViewer((element) => {
    element.playOutcome = "blocked";
  });
  const { element, player, viewer, owner, fixture } = group;
  try {
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => owner.status.group?.playback?.paused === false);
    await eventually(() => player.getState()?.awaitingInteraction === true);
    await Bun.sleep(1200);
    expect(element.paused).toBe(true);

    element.playOutcome = "plays";
    await player.allowPlayback();
    viewer.retry();
    await eventually(() => !element.paused);
    await Bun.sleep(700);
    expect(element.paused).toBe(false);
    expect(player.getState()).toMatchObject({ paused: false, awaitingInteraction: false });
    expect(element.currentTime).toBeGreaterThan(4);
  } finally {
    await group.close();
  }
});

test("a browser that leaves play() unanswered still follows what the group does next", async () => {
  const group = await groupViewer((element) => {
    // Some browsers neither start nor refuse playback in a page that is not in the foreground.
    element.playGate = new Promise(() => undefined);
  });
  const { element, owner, fixture } = group;
  try {
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => owner.status.group?.playback?.paused === false);
    await Bun.sleep(300);
    expect(element.paused).toBe(true);

    await owner.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: true,
      positionSeconds: 40,
    });
    await eventually(() => element.currentTime === 40);
    await owner.action({ type: "stop", itemId: fixture.itemId });
    await eventually(() => element.src === "");
  } finally {
    await group.close();
  }
});

test("a browser that stops fetching short of five seconds no longer keeps its watch group waiting", async () => {
  const group = await groupViewer((element) => {
    // Paused, a browser fetches as much as it sees fit, and may report little of it as buffered.
    element.bufferedRange = [0, 5];
  });
  const { element, viewer, owner, fixture } = group;
  try {
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 3 });
    await eventually(() => element.currentTime === 3);
    await Bun.sleep(400);
    expect(owner.status.group?.playback).toMatchObject({
      paused: true,
      waitingFor: [viewer.status.memberId],
    });

    element.networkState = 1;
    await eventually(() => owner.status.group?.playback?.paused === false);
    await eventually(() => !element.paused);
    expect(element.currentTime).toBe(3);
  } finally {
    await group.close();
  }
});

test("browser diagnostics retain waiting, stalled and recovery metrics without media grants or URLs", async () => {
  const { player, element } = setup();
  await player.start({ itemId: "private-media-title" });
  try {
    element.currentTime = 10;
    element.bufferedRange = [0, 10];
    element.emit("waiting");
    element.emit("stalled");
    element.bufferedRange = [0, 20];
    element.emit("playing");
    expect(
      JSON.parse(player.playbackDiagnostics()).playbackTimeline.map(
        (event: { kind: string }) => event.kind,
      ),
    ).toEqual(["browser_waiting", "browser_stalled", "browser_recovery"]);
    for (let index = 0; index < 300; index += 1) element.emit("stalled");
    const diagnostics = JSON.parse(player.playbackDiagnostics());
    expect(diagnostics.httpStatusAvailable).toBe(false);
    expect(diagnostics.playbackTimeline).toHaveLength(256);
    expect(JSON.stringify(diagnostics)).not.toContain("grant-");
    expect(JSON.stringify(diagnostics)).not.toContain("private-media");
    expect(diagnostics.playbackTimeline.at(-1).fields).toMatchObject({
      positionSeconds: 10,
      aheadSeconds: 10,
      intentionalPause: false,
      seeking: false,
      eof: false,
    });
  } finally {
    await player.stop();
  }
});

test("browser failure diagnostics export after teardown and isolate the next playback attempt", async () => {
  const { player, element } = setup();
  await player.start({ itemId: "private-title" });
  element.emit("waiting");
  element.fail(3);
  await eventually(() => player.getState() === null);
  const failed = JSON.parse(player.playbackDiagnostics());
  expect(failed.playbackTimeline.map((event: { kind: string }) => event.kind)).toContain("browser_error");
  expect(JSON.stringify(failed)).not.toContain("private-title");
  element.error = null;
  await player.start({ itemId: "other-title" });
  expect(JSON.parse(player.playbackDiagnostics()).playbackTimeline).toHaveLength(0);
  await player.stop();
});
