import { describe, expect, test } from "bun:test";
import { HtmlMediaPlayer, type MediaElementLike } from "../../apps/web/src/HtmlMediaPlayer";
import {
  PlaybackUnsupportedError,
  ServerHttpError,
  WatchPlaybackController,
} from "../../packages/client/src/index.ts";
import { eventually } from "../helpers/eventually";
import { watchFixture } from "../helpers/watch-groups";
import { defaultTrackMemory, describeTrack, type TrackChoiceInput, type TrackMemory, type PlayerSession, type PlayerState } from "../../packages/contracts/src/index.ts";

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
  audioTracks?: { readonly length: number; [index: number]: { enabled: boolean } };
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

const setup = (streams: PlayerSession["streams"] = []) => {
  const element = new FakeMedia();
  const calls: string[] = [];
  const states: (PlayerState | null)[] = [];
  const failures: string[] = [];
  let sessions = 0;
  const api = {
    serverOrigin: "http://lumen.test",
    memory: defaultTrackMemory(),
    saveFailure: false,
    saves: [] as TrackChoiceInput[],
    saveTrackChoice: async (_sessionId: string, input: TrackChoiceInput): Promise<TrackMemory> => {
      api.saves.push(input);
      if (api.saveFailure) throw new Error("offline");
      const stream = streams.find((candidate) => candidate.id === input.choice);
      if (input.choice !== null && input.choice !== "off" && stream === undefined) throw new Error("Missing test stream");
      api.memory = { ...api.memory, [input.kind]: input.choice === null ? null : input.choice === "off" ? "off" : stream === undefined ? null : describeTrack("source", stream) };
      return api.memory;
    },
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
        trackMemory: api.memory,
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
      { id: "a", kind: "audio", ordinal: 1, codec: "ac3", language: "eng", title: null, isDefault: true },
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
    const started = calls.filter((call) => call.startsWith("start")).map((call) => call.split(" ")[1]);
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
    expect(calls.slice(-2)).toEqual(["progress session-1 @15 #2 keepalive", "stop session-1 keepalive"]);
    // Restored from the back/forward cache: the ended session is replaced before resuming.
    await player.reconcile();
    expect(player.getState()).toMatchObject({ sessionId: "session-2", positionSeconds: 15, paused: false });
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

test("a watch group is not told the browser is ready until it holds five seconds to play on with", async () => {
  const fixture = await watchFixture();
  const { element, player } = setup();
  let seeks = 0;
  const viewer = new WatchPlaybackController(
    {
      start: ({ itemId, startAtSeconds, paused }) => player.start({ itemId, startAtSeconds, paused }),
      stop: () => player.stop(),
      getState: () => player.getState(),
      sample: (sessionId) => player.sample(sessionId),
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
});

/** A browser's player joined to a watch group, as the browser runtime wires the two together. */
const groupViewer = async (prepare: (element: FakeMedia) => void = () => undefined) => {
  const fixture = await watchFixture();
  const { element, player } = setup();
  element.bufferedRange = [0, 100];
  prepare(element);
  const viewer = new WatchPlaybackController(
    {
      start: ({ itemId, startAtSeconds, paused }) => player.start({ itemId, startAtSeconds, paused }),
      stop: () => player.stop(),
      getState: () => player.getState(),
      sample: (sessionId) => player.sample(sessionId),
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

test("browser synchronization samples fresh positions and halts projection across playback lifecycle", async () => {
  const { player, element } = setup();
  await player.start({ itemId: "item" });
  const sessionId = player.getState()?.sessionId ?? "";
  element.currentTime = 17;
  await player.speed(sessionId, 0.99);
  expect(player.sample(sessionId)).toMatchObject({ positionSeconds: 17, speed: 0.99, advancing: true });
  element.seeking = true;
  expect(player.sample(sessionId).advancing).toBe(false);
  element.seeking = false;
  element.emit("waiting");
  expect(player.sample(sessionId).advancing).toBe(false);
  element.emit("playing");
  await player.pause(sessionId, true);
  expect(player.sample(sessionId).advancing).toBe(false);
  await player.pause(sessionId, false);
  expect(player.sample(sessionId).advancing).toBe(true);
  element.ended = true;
  expect(player.sample(sessionId).advancing).toBe(false);
  element.ended = false;
  player.leave();
  expect(player.sample(sessionId).advancing).toBe(false);
  await player.stop();
  expect(element.playbackRate).toBe(1);
  expect(() => player.sample(sessionId)).toThrow();
});


describe("browser track memory", () => {
  const streams = [
    { id: "fr", kind: "audio", ordinal: 1, codec: "aac", language: "fra", title: null, isDefault: true },
    { id: "en", kind: "audio", ordinal: 2, codec: "aac", language: "eng", title: null, isDefault: false },
    { id: "sub", kind: "subtitle", ordinal: 3, codec: "subrip", language: "eng", title: null, isDefault: true },
  ] as const satisfies PlayerSession["streams"];
  test("supported audio is selected before play, and startup never saves", async () => {
    const f = setup(streams);
    f.element.audioTracks = { length: 2, 0: { enabled: true }, 1: { enabled: false } };
    await f.player.start({ itemId: "movie" });
    expect(f.element.audioTracks[0]?.enabled).toBe(false);
    expect(f.element.audioTracks[1]?.enabled).toBe(true);
    expect(f.player.getState()?.selectedAudioStreamId).toBe("en");
    expect(f.api.saves).toEqual([]);
    // Even selecting the current preference is an explicit media override.
    await f.player.selectAudioStream("session-1", "en");
    expect(f.api.memory.audio?.streamId).toBe("en");
    await f.player.resetTrack("session-1", "audio");
    expect(f.api.memory.audio).toBeNull();
    await f.player.stop();
  });
  test("unsupported subtitle and audio choices survive startup and reopening", async () => {
    const f = setup(streams);
    f.api.memory = { ...defaultTrackMemory(), audio: describeTrack("source", streams[1]), subtitle: describeTrack("source", streams[2]) };
    await f.player.start({ itemId: "movie" });
    expect(f.player.getState()?.streams).toEqual([]);
    expect(f.player.getState()?.selectedSubtitleStreamId).toBeNull();
    expect(f.api.saves).toEqual([]);
    f.player.leave(); await f.player.reconcile();
    expect(f.api.memory.subtitle).not.toBeNull(); expect(f.api.memory.audio?.streamId).toBe("en");
    // An explicit reset can still clear an unsupported choice on the server.
    await f.player.resetTrack("session-2", "subtitle");
    expect(f.api.memory.subtitle).toBeNull(); expect(f.api.memory.audio?.streamId).toBe("en");
    await f.player.stop();
  });
  test("mismatched browser track counts do not guess track identity", async () => {
    const f = setup(streams);
    f.element.audioTracks = { length: 1, 0: { enabled: true } };
    await f.player.start({ itemId: "movie" });
    expect(f.player.getState()?.streams).toEqual([]);
    await expect(f.player.selectAudioStream("session-1", "en")).rejects.toThrow("unavailable");
    expect(f.api.saves).toEqual([]); await f.player.stop();
  });
  test("a codec the browser cannot decode is not selected or saved", async () => {
    const f = setup(streams.map((stream) => stream.id === "fr" ? { ...stream, codec: "ac3" } : stream));
    f.element.audioTracks = { length: 2, 0: { enabled: false }, 1: { enabled: true } };
    await f.player.start({ itemId: "movie" });
    await expect(f.player.selectAudioStream("session-1", "fr")).rejects.toThrow("AC3 audio");
    expect(f.api.saves).toEqual([]); expect(f.element.audioTracks[1]?.enabled).toBe(true);
    await f.player.stop();
  });
  test("save failures leave audio playing with a retryable error", async () => {
    const f = setup(streams);
    f.element.audioTracks = { length: 2, 0: { enabled: true }, 1: { enabled: false } };
    await f.player.start({ itemId: "movie" }); f.api.saveFailure = true;
    const state = await f.player.selectAudioStream("session-1", "fr");
    expect(state).toMatchObject({ selectedAudioStreamId: "fr", paused: false });
    expect(state.trackMemoryError).toContain("Retry"); expect(f.failures).toEqual([]);
    f.api.saveFailure = false; await f.player.retryTrackMemory("session-1");
    expect(f.api.memory.audio?.streamId).toBe("fr"); expect(f.player.getState()?.trackMemoryError).toBeNull();
    await f.player.stop();
  });
});
