import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { defaultTrackMemory, describeTrack, type PlayerSession, type TrackChoiceInput, type TrackMemory, type PlayerState } from "../../packages/contracts/src/index.ts";
import type { BrowserWindow } from "electron";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import {
  PlaybackSessionReporter,
  WatchPlaybackController,
} from "../../packages/client/src/index.ts";
import { eventually } from "../helpers/eventually";
import { watchFixture } from "../helpers/watch-groups";
import { electronTestExports } from "../helpers/electron";
import { MacMpvWindow } from "../../apps/desktop/src/main/player/MacMpvWindow";

const events: string[] = [];

class FakeBaseWindow {
  private visible = false;
  private destroyed = false;

  constructor() {
    events.push("host:create");
  }

  setMenuBarVisibility(): void {}
  setIgnoreMouseEvents(): void {}
  setBounds(): void {}
  getNativeWindowHandle(): Buffer {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(11n);
    return handle;
  }
  showInactive(): void {
    this.visible = true;
    events.push("host:show");
  }
  hide(): void {
    if (this.visible) events.push("host:hide");
    this.visible = false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

mock.module("electron", () => ({ ...electronTestExports, BaseWindow: FakeBaseWindow }));
const { MpvSurface } = await import("../../apps/desktop/src/main/player/MpvSurface");
const { PlayerController, startNativePlayer, watchPlayerFor } = await import("../../apps/desktop/src/main/player/PlayerController");
const { MpvIpc, MpvIpcFailure } = await import("../../apps/desktop/src/main/player/MpvIpc");
const { MpvProcess } = await import("../../apps/desktop/src/main/player/MpvProcess");

const withPlayback = async (
  run: (playback: {
    controller: InstanceType<typeof PlayerController>;
    states: PlayerState[];
    properties: Map<string, unknown>;
    heartbeat: ReturnType<typeof mock>;
    progress: ReturnType<typeof mock>;
    request: ReturnType<typeof mock>;
    stopProcess: ReturnType<typeof mock>;
    saveChoice: ReturnType<typeof mock>;
    connections: InstanceType<typeof MpvIpc>[];
    exits: (() => void)[];
    restart: () => Promise<unknown>;
    failNextLoad: () => void;
    disconnectNextStart: () => void;
  }) => Promise<void>,
  trackOptions?: { streams: PlayerSession["streams"]; memory?: TrackMemory },
): Promise<void> => {
  const stopProcess = mock(async () => undefined);
  const exits: (() => void)[] = [];
  const connections: InstanceType<typeof MpvIpc>[] = [];
  const startProcess = spyOn(MpvProcess, "start").mockImplementation((options) => {
    exits.push(() => options.onExit?.(1));
    return { stop: stopProcess } as unknown as MpvProcess;
  });
  const connect = spyOn(MpvIpc.prototype, "connect").mockImplementation(async function (this: InstanceType<typeof MpvIpc>) {
    connections.push(this);
  });
  const properties = new Map<string, unknown>([
    ["window-id", 1],
    ["time-pos", 12.25],
    ["duration", 60],
    ["pause", false],
    ["eof-reached", false],
    ["paused-for-cache", false],
    ["seeking", false],
    ["speed", 1],
  ]);
  if (trackOptions !== undefined) properties.set("track-list", trackOptions.streams.map((stream) => ({ id: stream.ordinal + 10, type: stream.kind === "audio" ? "audio" : "sub", "ff-index": stream.ordinal })));
  let failLoad = false;
  let disconnectStart = false;
  const command = spyOn(MpvIpc.prototype, "command").mockImplementation(function (
    this: InstanceType<typeof MpvIpc>,
    args: ReadonlyArray<string | number>,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    if (disconnectStart && args[0] === "set_property" && args[1] === "audio-channels") {
      queueMicrotask(() => this.emit("disconnected", new MpvIpcFailure("MPV IPC closed")));
      return Promise.reject(new MpvIpcFailure("MPV IPC closed"));
    }
    if (args[0] === "loadfile") {
      queueMicrotask(() => this.emit(failLoad ? "end-file" : "file-loaded", { reason: "error", file_error: "network failure" }));
    }
    if (args[0] === "expand-text") {
      const sample = properties.get("watch-sample");
      if (sample instanceof Promise) return sample;
      return Promise.resolve(String(args[1]).replace(/\$\{=([^}]+)\}/g, (_match, property) => {
        const value = properties.get(property);
        return typeof value === "boolean" ? value ? "yes" : "no" : String(value);
      }));
    }
    if (args[0] === "seek") properties.set("time-pos", args[1]);
    if (args[0] === "set_property")
      properties.set(String(args[1]), args[2] === "yes" ? true : args[2] === "no" ? false : args[2]);
    const value = args[0] === "get_property" ? properties.get(String(args[1])) : null;
    if (value instanceof Promise)
      return Promise.race([
        value,
        new Promise((_, reject) => setTimeout(() => reject(new Error("MPV command timed out")), timeoutMs)),
      ]);
    return Promise.resolve(value);
  });
  const states: PlayerState[] = [];
  const heartbeat = mock(async () => undefined);
  const progress = mock(async () => undefined);
  const request = mock(async () => undefined);
  let memory = trackOptions?.memory ?? defaultTrackMemory();
  const saveChoice = mock(async (_id: string, input: TrackChoiceInput) => {
    const stream = trackOptions?.streams.find((candidate) => candidate.id === input.choice);
    if (input.choice !== null && input.choice !== "off" && stream === undefined) throw new Error("Missing test stream");
    memory = { ...memory, [input.kind]: input.choice === null ? null : input.choice === "off" ? "off" : stream === undefined ? null : describeTrack("source", stream) };
    return memory;
  });
  let sessionNumber = 0;
  const client = {
    serverOrigin: "http://localhost:3000",
    startPlayback: async () => ({
      sessionId: `session-${++sessionNumber}`,
      itemId: "item-1",
      sourceId: "source",
      trackMemory: memory,
      streamUrl: "/stream",
      grantToken: "grant",
      durationSeconds: 60,
      streams: trackOptions?.streams ?? [],
    }),
    saveTrackChoice: saveChoice,
    stopPlayback: request,
    heartbeat,
    progress,
  };
  const controller = new PlayerController({
    bridge: {
      register: () => ({ capability: "test", url: "http://127.0.0.1/video" }),
      revoke: () => undefined,
    },
    surface: {
      prepare: () => [],
      attachNativeWindow: () => undefined,
      show: () => undefined,
      hide: () => undefined,
    },
    onState: (state: PlayerState) => states.push(state),
  } as unknown as ConstructorParameters<typeof PlayerController>[0]);
  try {
    await controller.start({ client, connectionId: "connection-1", itemId: "item-1" } as unknown as Parameters<typeof controller.start>[0]);
    states.length = 0;
    await run({ controller, states, properties, heartbeat, progress, request, stopProcess, saveChoice, connections, exits,
      restart: () => controller.start({ client, connectionId: "connection-1", itemId: "item-1" } as unknown as Parameters<typeof controller.start>[0]),
      failNextLoad: () => { failLoad = true; },
      disconnectNextStart: () => { disconnectStart = true; },
    });
  } finally {
    await controller.stop();
    startProcess.mockRestore();
    connect.mockRestore();
    command.mockRestore();
  }
};

test("MPV reports how far it has read ahead, and when it has run out", async () => {
  await withPlayback(async ({ controller, properties }) => {
    properties.set("seeking", true);
    properties.set("demuxer-cache-state", { "cache-duration": 12, eof: false });
    properties.set("paused-for-cache", true);
    // What MPV holds describes the position it is leaving until the seek is over.
    expect(await controller.buffer("session-1")).toEqual({ aheadSeconds: 0, starved: false, settled: false });
    properties.set("seeking", false);
    expect(await controller.buffer("session-1")).toEqual({ aheadSeconds: 12, starved: true, settled: false });
    properties.set("paused-for-cache", false);
    properties.set("demuxer-cache-state", { "cache-duration": 2.5, eof: true });
    expect(await controller.buffer("session-1")).toEqual({
      aheadSeconds: Number.POSITIVE_INFINITY,
      starved: false,
      settled: false,
    });
    properties.set("demuxer-cache-state", null);
    expect(await controller.buffer("session-1")).toEqual({ aheadSeconds: 0, starved: false, settled: false });
  });
});

describe("playback progress updates", () => {
  test("pausing saves the current MPV position without waiting for the reporting timer", async () => {
    await withPlayback(async ({ controller, properties, progress }) => {
      properties.set("time-pos", 27.5);
      await controller.pause("session-1", true);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ paused: true, positionSeconds: 27.5 }),
        1,
      );
      await controller.pause("session-1", false);
      expect(progress).toHaveBeenCalledTimes(1);
    });
  });

  test("a failed progress request does not undo a successful pause", async () => {
    await withPlayback(async ({ controller, progress }) => {
      progress.mockRejectedValueOnce(new Error("server unavailable"));
      await expect(controller.pause("session-1", true)).resolves.toMatchObject({ paused: true });
      expect(controller.getState()?.paused).toBe(true);
    });
  });

  test("a delayed pause sample cannot overwrite a newer seek", async () => {
    await withPlayback(async ({ controller, properties }) => {
      const pending = Promise.withResolvers<number>();
      properties.set("time-pos", pending.promise);
      const pausing = controller.pause("session-1", true);
      await Promise.resolve();
      controller.seek("session-1", 40);
      pending.resolve(12.25);
      await pausing;
      expect(controller.getState()?.positionSeconds).toBe(40);
    });
  });

  test("a slow heartbeat cannot reuse the sequence of a pause save", async () => {
    await withPlayback(async ({ controller, properties, heartbeat, progress }) => {
      for (let tick = 0; tick < 5; tick++) await controller.tick();
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      heartbeat.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const reporting = controller.tick();
      await started.promise;
      properties.set("time-pos", 30);
      await controller.pause("session-1", true);
      pending.resolve();
      await reporting;
      expect(progress).toHaveBeenNthCalledWith(
        1,
        "session-1",
        expect.objectContaining({ paused: true, positionSeconds: 30 }),
        7,
      );
      expect(progress).toHaveBeenNthCalledWith(2, "session-1", expect.anything(), 6);
    });
  });

  test("leaving the player saves its last position before closing the server session", async () => {
    await withPlayback(async ({ controller, properties, progress, request }) => {
      const calls: string[] = [];
      progress.mockImplementation(async () => { calls.push("progress"); });
      request.mockImplementation(async () => { calls.push("delete"); });
      properties.set("time-pos", 41.75);
      await controller.stop();
      expect(progress).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ positionSeconds: 41.75 }),
        1,
      );
      expect(calls).toEqual(["progress", "delete"]);
    });
  });

  test("a slow MPV shutdown does not delay the final save", async () => {
    await withPlayback(async ({ controller, progress, request, stopProcess }) => {
      const pending = Promise.withResolvers<void>();
      const saved = Promise.withResolvers<void>();
      stopProcess.mockImplementation(() => pending.promise);
      progress.mockImplementation(async () => { saved.resolve(); });
      const stopping = controller.stop();
      try {
        await saved.promise;
        expect(progress).toHaveBeenCalledTimes(1);
        expect(request).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        await stopping;
      }
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  test("an unresponsive MPV position query falls back to the last sampled position", async () => {
    await withPlayback(async ({ controller, properties, progress }) => {
      await controller.refreshState();
      properties.set("time-pos", new Promise(() => undefined));
      await controller.stop();
      expect(progress).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ positionSeconds: 12.25 }),
        1,
      );
    });
  });

  test("final progress starts even when a periodic write is stalled", async () => {
    await withPlayback(async ({ controller, properties, progress, request }) => {
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const saved = Promise.withResolvers<void>();
      progress.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      progress.mockImplementation(async () => { saved.resolve(); });
      for (let tick = 0; tick < 5; tick++) await controller.tick();
      const reporting = controller.tick();
      await started.promise;
      properties.set("time-pos", 30);
      const stopping = controller.stop();
      try {
        await saved.promise;
        expect(progress).toHaveBeenCalledTimes(2);
      } finally {
        pending.resolve();
        await Promise.all([reporting, stopping]);
      }
      expect(progress).toHaveBeenLastCalledWith(
        "session-1",
        expect.objectContaining({ positionSeconds: 30 }),
        7,
      );
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  test("publishes multiple position samples within one second without server requests", async () => {
    await withPlayback(async ({ controller, states, heartbeat, progress }) => {
      const stopUpdates = startNativePlayer(controller);
      try {
        await Bun.sleep(950);
        expect(states.length).toBeGreaterThanOrEqual(3);
        expect(states.at(-1)?.positionSeconds).toBe(12.25);
        expect(heartbeat).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
      } finally {
        stopUpdates();
      }
    });
  });

  test("frequent sampling preserves the heartbeat and saved-progress cadence", async () => {
    await withPlayback(async ({ controller, heartbeat, progress }) => {
      for (let tick = 1; tick <= 6; tick++) {
        for (let sample = 0; sample < 12; sample++) await controller.refreshState();
        await controller.tick();
        expect(heartbeat).toHaveBeenCalledTimes(Math.floor(tick / 3));
        expect(progress).toHaveBeenCalledTimes(tick === 6 ? 1 : 0);
      }
      expect(progress).toHaveBeenLastCalledWith(
        "session-1",
        expect.objectContaining({ positionSeconds: 12.25 }),
        6,
      );
    });
  });

  test("a slow server heartbeat does not block position updates", async () => {
    await withPlayback(async ({ controller, heartbeat, properties }) => {
      const pending = Promise.withResolvers<void>();
      heartbeat.mockImplementation(() => pending.promise);
      await controller.tick();
      await controller.tick();
      const reporting = controller.tick();
      try {
        properties.set("time-pos", 24.5);
        await controller.refreshState();
        expect(controller.getState()?.positionSeconds).toBe(24.5);
        await controller.tick();
        expect(heartbeat).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve();
        await reporting;
      }
    });
  });

  test("a pending sample cannot overwrite a seek or resurrect a stopped session", async () => {
    await withPlayback(async ({ controller, states }) => {
      const sampling = controller.refreshState();
      controller.seek("session-1", 40);
      await sampling;
      expect(controller.getState()?.positionSeconds).toBe(40);
      expect(states).toHaveLength(1);

      const stoppingSample = controller.refreshState();
      await controller.stop();
      await stoppingSample;
      expect(controller.getState()).toBeNull();
      expect(states).toHaveLength(1);
    });
  });

  test("overlapping polls publish once and report pause and end-of-file accurately", async () => {
    await withPlayback(async ({ controller, states, properties }) => {
      properties.set("pause", true);
      await Promise.all([controller.refreshState(), controller.refreshState()]);
      expect(states).toHaveLength(1);
      expect(controller.getState()?.paused).toBe(true);

      properties.set("time-pos", 60);
      properties.set("eof-reached", true);
      await controller.refreshState();
      expect(controller.getState()).toMatchObject({ positionSeconds: 60, ended: true });
    });
  });
});

describe("Windows player surface visibility", () => {
  const withSurface = async (
    run: (fixture: {
      surface: InstanceType<typeof MpvSurface>;
      host: FakeBaseWindow;
      parent: EventEmitter;
      overlayWindow: EventEmitter;
      state: { focused: boolean; overlayFocused: boolean; minimized: boolean; visible: boolean };
    }) => Promise<void>,
  ): Promise<void> => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const state = { focused: true, overlayFocused: false, minimized: false, visible: true };
    const parent = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isFocused: () => state.focused,
      isMinimized: () => state.minimized,
      isVisible: () => state.visible,
      getContentSize: () => [800, 600],
      getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    });
    const overlayWindow = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isFocused: () => state.overlayFocused,
    });
    const surface = new MpvSurface(parent as unknown as BrowserWindow, {
      window: overlayWindow,
      moveAboveVideo: () => undefined,
    } as unknown as ConstructorParameters<typeof MpvSurface>[1]);
    const host = new FakeBaseWindow();
    // Exercise the Windows surface policy on any OS without loading user32.dll.
    Reflect.set(surface, "host", host);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      surface.setBounds({ x: 0, y: 0, width: 800, height: 600 });
      surface.prepare();
      expect(host.isVisible()).toBe(true);
      await run({ surface, host, parent, overlayWindow, state });
    } finally {
      surface.dispose();
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  };

  test("keeps video visible when focus moves through controls to another app", async () => {
    await withSurface(async ({ host, parent, overlayWindow, state }) => {
      state.focused = false;
      state.overlayFocused = true;
      parent.emit("blur");
      overlayWindow.emit("focus");
      await Bun.sleep(10);
      expect(host.isVisible()).toBe(true);

      const show = spyOn(host, "showInactive");
      const hide = spyOn(host, "hide");
      try {
        state.overlayFocused = false;
        overlayWindow.emit("blur");
        await Bun.sleep(10);
        expect(host.isVisible()).toBe(true);
        expect(hide).not.toHaveBeenCalled();
        // Do not raise the video over the newly focused app either.
        expect(show).not.toHaveBeenCalled();

        state.focused = true;
        parent.emit("focus");
        expect(host.isVisible()).toBe(true);
        expect(show).toHaveBeenCalledTimes(1);
      } finally {
        show.mockRestore();
        hide.mockRestore();
      }
    });
  });

  for (const event of ["minimize", "hide"] as const) {
    test(`hides video on ${event} and keeps late updates from revealing it`, async () => {
      await withSurface(async ({ surface, host, parent, overlayWindow, state }) => {
        state.minimized = event === "minimize";
        state.visible = event !== "hide";
        parent.emit(event);
        expect(host.isVisible()).toBe(false);
        surface.show();
        surface.setBounds({ x: 0, y: 0, width: 800, height: 600 });
        overlayWindow.emit("focus");
        await Bun.sleep(10);
        expect(host.isVisible()).toBe(false);
        surface.hide();
        surface.prepare();
        expect(host.isVisible()).toBe(false);

        state.minimized = false;
        state.visible = true;
        parent.emit(event === "minimize" ? "restore" : "show");
        expect(host.isVisible()).toBe(true);
      });
    });
  }

  test("focus cannot reveal video after leaving the player or stopping playback", async () => {
    await withSurface(async ({ surface, host, parent }) => {
      surface.setBounds(null);
      parent.emit("focus");
      expect(host.isVisible()).toBe(false);
      surface.setBounds({ x: 0, y: 0, width: 800, height: 600 });
      expect(host.isVisible()).toBe(true);
      surface.hide();
      parent.emit("focus");
      expect(host.isVisible()).toBe(false);
      surface.dispose();
      expect(host.isDestroyed()).toBe(true);
      expect(parent.listenerCount("hide")).toBe(0);
      expect(parent.listenerCount("minimize")).toBe(0);
    });
  });
});

describe("player surface shutdown", () => {
  for (const stopped of [false, true]) {
    test(`queued focus work cannot access a closed window (${stopped ? "after Back" : "during playback"})`, () => {
      const callbacks: Array<() => void> = [];
      const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
        callbacks.push(callback);
        return 123;
      }) as unknown as typeof setTimeout);
      const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
      const parent = new EventEmitter();
      let destroyed = false;
      Object.assign(parent, {
        isDestroyed: () => destroyed,
        isFocused: () => {
          if (destroyed) throw new TypeError("Object has been destroyed");
          return false;
        },
      });
      const overlayWindow = new EventEmitter();
      Object.assign(overlayWindow, { isDestroyed: () => true, isFocused: () => {
        throw new TypeError("Object has been destroyed");
      } });
      try {
        const surface = new MpvSurface(parent as BrowserWindow, { window: overlayWindow } as unknown as ConstructorParameters<typeof MpvSurface>[1]);
        Reflect.set(surface, "playbackVisible", true);
        if (stopped) surface.hide();
        parent.emit("blur");
        overlayWindow.emit("blur");
        destroyed = true;
        parent.emit("closed");

        // Exercise even a callback already handed to the event loop. Cleanup
        // should cancel it, and its own guard must still make it harmless.
        for (const callback of callbacks) expect(callback).not.toThrow();
        expect(cancel).toHaveBeenCalled();
        expect(parent.listenerCount("blur")).toBe(0);
        expect(parent.listenerCount("focus")).toBe(0);
        expect(overlayWindow.listenerCount("blur")).toBe(0);
        const scheduled = callbacks.length;
        parent.emit("blur");
        overlayWindow.emit("focus");
        expect(callbacks).toHaveLength(scheduled);
        surface.dispose();
      } finally {
        schedule.mockRestore();
        cancel.mockRestore();
      }
    });
  }
});

describe("macOS MPV window lifecycle", () => {
  test.skipIf(process.platform !== "darwin")("play, Back, and immediate replay attach and detach once per session", () => {
    events.length = 0;
    const parent = {
      on: () => undefined,
      once: () => undefined,
      off: () => undefined,
      isDestroyed: () => false,
      getContentSize: () => [800, 600],
      getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    } as unknown as BrowserWindow;
    const surface = new MpvSurface(parent, undefined, (_host, windowId) => {
      events.push(`mpv:attach:${windowId}`);
      return {
        sync: () => undefined,
        show: () => undefined,
        dispose: () => events.push(`mpv:detach:${windowId}`),
      };
    });
    surface.setBounds({ x: 0, y: 0, width: 800, height: 600 });

    surface.prepare();
    surface.attachNativeWindow(101);
    surface.hide(); // Back stops playback before libmpv is destroyed.
    surface.hide(); // A second stop must not detach the same native window.
    surface.prepare();
    surface.attachNativeWindow(202);
    surface.hide();

    expect(events).toEqual([
      "host:create",
      "host:show",
      "mpv:attach:101",
      "host:hide",
      "mpv:detach:101",
      "host:show",
      "mpv:attach:202",
      "host:hide",
      "mpv:detach:202",
    ]);
    surface.dispose();
  });

  test("Cocoa teardown never messages the MPV window and cannot run twice", () => {
    const selectors = new Map<bigint, string>();
    const calls: string[] = [];
    let nextSelector = 1n;
    const loadLibrary = (() => ({
      func: (symbol: string, result: unknown) => {
        if (symbol === "sel_registerName")
          return (name: string) => {
            const id = nextSelector++;
            selectors.set(id, name);
            return id;
          };
        if (result === "void *") return () => 11n;
        if (result !== "void")
          return () => ({ origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } });
        return (receiver: bigint, selector: bigint) => {
          calls.push(`${receiver}:${selectors.get(selector)}`);
        };
      },
      unload: () => calls.push("unload"),
    })) as unknown as typeof import("koffi").load;

    const window = new MacMpvWindow(10n, 20n, loadLibrary);
    window.dispose();
    window.sync();
    window.show();
    window.dispose();

    expect(calls).toEqual([
      "11:addChildWindow:ordered:",
      "20:setFrame:display:",
      "20:orderFront:",
      "11:removeChildWindow:",
      "unload",
    ]);
  });

  test("overlapping stops wait for the same libmpv destruction", async () => {
    const calls: string[] = [];
    let finishDestroy = (): void => undefined;
    const destroying = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const controller = new PlayerController({
      bridge: { revoke: () => calls.push("revoke") },
      surface: { hide: () => calls.push("hide") },
      onState: () => undefined,
    } as unknown as ConstructorParameters<typeof PlayerController>[0]);
    await controller.stop(); // First start also stops with no active session.
    calls.length = 0;
    Reflect.set(controller, "active", {
      session: { sessionId: "session-1" },
      reporter: new PlaybackSessionReporter(
        {
          heartbeat: async () => undefined,
          progress: async () => undefined,
          stopPlayback: async () => {
            calls.push("delete session");
          },
        },
        "session-1",
        () => undefined,
      ),
      process: {
        stop: async () => {
          calls.push("destroy:start");
          await destroying;
          calls.push("destroy:done");
        },
      },
      ipc: { close: () => calls.push("close IPC") },
      capability: "capability-1",
      cancellation: new AbortController(),
    });

    let firstFinished = false;
    let secondFinished = false;
    const first = controller.stop().then(() => {
      firstFinished = true;
    });
    const second = controller.stop().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    expect(calls).toEqual(["hide", "revoke", "close IPC", "destroy:start"]);

    finishDestroy();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "hide",
      "revoke",
      "close IPC",
      "destroy:start",
      "destroy:done",
      "delete session",
    ]);
  });

  test.skipIf(process.platform !== "darwin")("controller plays, stops on Back, and replays after destruction", async () => {
    const calls: string[] = [];
    let sessionNumber = 0;
    let windowNumber = 0;
    const startProcess = spyOn(MpvProcess, "start").mockImplementation(() => {
      calls.push("process:start");
      return {
        stop: async () => {
          calls.push("process:destroy");
        },
      } as unknown as MpvProcess;
    });
    const connect = spyOn(MpvIpc.prototype, "connect").mockImplementation(async () => {
      calls.push("ipc:connect");
    });
    const command = spyOn(MpvIpc.prototype, "command").mockImplementation(function (
      this: InstanceType<typeof MpvIpc>,
      args: ReadonlyArray<string | number>,
    ): Promise<unknown> {
      if (args[0] === "loadfile") queueMicrotask(() => this.emit("file-loaded"));
      if (args[0] === "get_property" && args[1] === "window-id") return Promise.resolve(++windowNumber);
      return Promise.resolve(null);
    });
    const close = spyOn(MpvIpc.prototype, "close").mockImplementation(() => {
      calls.push("ipc:close");
    });
    try {
      const controller = new PlayerController({
        bridge: {
          register: () => ({ capability: "test", url: "http://127.0.0.1/video" }),
          revoke: () => calls.push("bridge:revoke"),
        },
        surface: {
          prepare: () => {
            calls.push("surface:prepare");
            return [];
          },
          attachNativeWindow: (windowId: number) => calls.push(`surface:attach:${windowId}`),
          show: () => calls.push("surface:show"),
          hide: () => calls.push("surface:hide"),
        },
        onState: () => undefined,
      } as unknown as ConstructorParameters<typeof PlayerController>[0]);
      const client = {
        serverOrigin: "http://localhost:3000",
        startPlayback: async () => {
          sessionNumber += 1;
          return {
            sessionId: `session-${sessionNumber}`,
            itemId: "item-1",
            streamUrl: "/stream",
            grantToken: "grant",
            durationSeconds: 60,
            streams: [],
          };
        },
        stopPlayback: async () => calls.push("session:delete"),
      };

      await controller.start({ client, connectionId: "connection-1", itemId: "item-1" } as unknown as Parameters<typeof controller.start>[0]);
      await controller.stop(); // Back
      await controller.start({ client, connectionId: "connection-1", itemId: "item-1" } as unknown as Parameters<typeof controller.start>[0]);
      await controller.stop();

      expect(calls.filter((call) => call.startsWith("surface:") || call.startsWith("process:"))).toEqual([
        "surface:hide",
        "surface:prepare",
        "process:start",
        "surface:attach:1",
        "surface:show",
        "surface:hide",
        "process:destroy",
        "surface:hide",
        "surface:prepare",
        "process:start",
        "surface:attach:2",
        "surface:show",
        "surface:hide",
        "process:destroy",
      ]);
      expect(calls.filter((call) => call === "session:delete")).toHaveLength(2);
    } finally {
      startProcess.mockRestore();
      connect.mockRestore();
      command.mockRestore();
      close.mockRestore();
    }
  });
});


describe("native playback failure recovery", () => {
  test("a failure during media loading tears down that startup exactly once", async () => {
    await withPlayback(async ({ controller, failNextLoad, restart, stopProcess, request }) => {
      await controller.stop();
      stopProcess.mockClear();
      request.mockClear();
      failNextLoad();
      await expect(restart()).rejects.toThrow("network failure");
      expect(controller.getState()).toBeNull();
      expect(stopProcess).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  test("a disconnect during initialization consumes the load failure and tears down once", async () => {
    await withPlayback(async ({ controller, disconnectNextStart, restart, stopProcess, request }) => {
      await controller.stop();
      stopProcess.mockClear();
      request.mockClear();
      disconnectNextStart();
      await expect(restart()).rejects.toThrow("MPV IPC closed");
      expect(controller.getState()).toBeNull();
      expect(stopProcess).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  test("a stalled IPC query invalidates playback while transient unavailable properties retain it", async () => {
    await withPlayback(async ({ controller, properties }) => {
      properties.set("time-pos", Promise.reject(new Error("property unavailable")));
      await controller.refreshState();
      expect(controller.getState()?.sessionId).toBe("session-1");
      properties.set("time-pos", Promise.reject(new MpvIpcFailure("MPV command timed out")));
      await controller.refreshState();
      expect(controller.getState()).toBeNull();
    });
  });

  test("an exited process invalidates its session and late failure callbacks cannot clear its replacement", async () => {
    await withPlayback(async ({ controller, exits, connections, restart, stopProcess, request }) => {
      exits[0]?.();
      expect(controller.getState()).toBeNull();
      await restart();
      expect(controller.getState()?.sessionId).toBe("session-2");
      expect(stopProcess).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
      exits[0]?.();
      connections[0]?.emit("disconnected", new Error("old IPC closed"));
      expect(controller.getState()?.sessionId).toBe("session-2");
      expect(stopProcess).toHaveBeenCalledTimes(1);
    });
  });

  test("an established IPC failure restarts shared playback at the group position after its surface is ready", async () => {
    const fixture = await watchFixture();
    try {
      await withPlayback(async ({ controller, connections }) => {
        const watch = new WatchPlaybackController(watchPlayerFor(controller), () => undefined);
        try {
          const owner = await fixture.connect(await fixture.login());
          await owner.action({ type: "create", name: "Movie night", password: "" });
          await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 7 });
          await owner.action({ type: "pause", itemId: fixture.itemId, positionSeconds: 7, paused: true });
          const viewer = new ServerClient({ origin: fixture.running.server.url.origin });
          await viewer.identity();
          viewer.setSession((await fixture.login()).currentSession);
          watch.connect(viewer, "viewer");
          watch.setSurfaceReady(true);
          await eventually(() => watch.status.connection === "connected");
          await watch.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
          await eventually(() => controller.getState()?.itemId === fixture.itemId && controller.getState()?.paused === true);
          const failedSession = controller.getState()?.sessionId;
          const started = connections.length;
          watch.setSurfaceReady(false);
          connections.at(-1)?.emit("disconnected", new Error("MPV IPC closed"));
          expect(controller.getState()).toBeNull();
          await Bun.sleep(600);
          expect(connections).toHaveLength(started);
          watch.setSurfaceReady(true);
          await eventually(() => controller.getState() !== null);
          expect(controller.getState()).toMatchObject({ itemId: fixture.itemId, paused: true, positionSeconds: 7 });
          expect(controller.getState()?.sessionId).not.toBe(failedSession);
          connections.at(-1)?.emit("disconnected", new Error("MPV IPC closed"));
          const beforeStop = connections.length;
          await watch.stop();
          watch.retry();
          await Bun.sleep(1100);
          expect(controller.getState()).toBeNull();
          expect(connections).toHaveLength(beforeStop);
          expect(watch.status.group?.playback).toBeNull();
        } finally {
          watch.close();
        }
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);
});

test("solo playback reports buffering while the cache is drained or a seek is loading, unless paused or ended", async () => {
  await withPlayback(async ({ controller, properties }) => {
    const buffering = async (): Promise<boolean | undefined> => {
      await controller.refreshState();
      return controller.getState()?.buffering;
    };
    expect(await buffering()).toBe(false);
    properties.set("paused-for-cache", true);
    expect(await buffering()).toBe(true);
    properties.set("paused-for-cache", false);
    expect(await buffering()).toBe(false);
    properties.set("seeking", true);
    expect(await buffering()).toBe(true);
    await controller.pause("session-1", true);
    properties.set("pause", true);
    expect(await buffering()).toBe(false);
    await controller.pause("session-1", false);
    properties.set("pause", false);
    properties.set("seeking", false);
    properties.set("paused-for-cache", true);
    properties.set("eof-reached", true);
    expect(await buffering()).toBe(false);
  });
});

test("solo playback records starvation/recovery and suppresses intentional pause, seek and EOF starvation", async () => {
  await withPlayback(async ({ controller, properties }) => {
    properties.set("demuxer-cache-state", { "cache-duration": 0 });
    properties.set("seeking", false);
    properties.set("paused-for-cache", true);
    await controller.refreshState();
    properties.set("demuxer-cache-state", { "cache-duration": 8 });
    properties.set("paused-for-cache", false);
    await controller.refreshState();
    await controller.pause("session-1", true);
    properties.set("pause", true);
    properties.set("paused-for-cache", true);
    await controller.refreshState();
    await controller.pause("session-1", false);
    properties.set("pause", false);
    properties.set("seeking", true);
    await controller.refreshState();
    properties.set("seeking", false);
    properties.set("eof-reached", true);
    await controller.refreshState();
    const diagnostics = JSON.parse(await controller.audioDiagnostics("session-1"));
    expect(
      diagnostics.playbackTimeline.filter(
        (event: { kind: string }) => event.kind === "buffer_starvation",
      ),
    ).toHaveLength(1);
    expect(
      diagnostics.playbackTimeline.filter(
        (event: { kind: string }) => event.kind === "buffer_recovery",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(diagnostics.playbackTimeline)).not.toContain("http");
    await controller.stop();
    expect(
      JSON.parse(await controller.audioDiagnostics("session-1")).playbackTimeline,
    ).toHaveLength(diagnostics.playbackTimeline.length);
  });
});

test("desktop export retains runtime and startup failure diagnostics without a live player", async () => {
  await withPlayback(async ({ controller, connections, restart, failNextLoad }) => {
    connections[0]?.emit("disconnected", new MpvIpcFailure("private-path failure"));
    await controller.stop();
    expect(controller.getState()).toBeNull();
    const failed = await controller.audioDiagnostics("");
    expect(JSON.parse(failed).playbackTimeline.map((event: { kind: string }) => event.kind)).toContain("playback_failure");
    expect(failed).not.toContain("private-path");
    failNextLoad();
    await expect(restart()).rejects.toBeDefined();
    const startup = JSON.parse(await controller.audioDiagnostics(""));
    expect(startup.playbackTimeline.some((event: { fields: { stage?: string } }) => event.fields.stage === "startup")).toBe(true);
    expect(startup.playbackTimeline.some((event: { fields: { stage?: string } }) => event.fields.stage === "runtime")).toBe(false);
  });
});


test("native watch samples are invalidated by pause, seek, speed and replacement during IPC", async () => {
  await withPlayback(async ({ controller, properties, restart }) => {
    expect(await controller.sample("session-1")).toMatchObject({ positionSeconds: 12.25, speed: 1, advancing: true });
    for (const motion of [
      () => controller.pause("session-1", true),
      () => controller.seek("session-1", 20),
      () => controller.speed("session-1", 0.99),
      restart,
    ]) {
      let release = (_value: string) => {};
      properties.set("watch-sample", new Promise<string>((resolve) => { release = resolve; }));
      const pending = controller.sample("session-1");
      await motion();
      release("12.25\tno\tno\tno\tno\t1");
      expect(await pending).toBeNull();
      properties.delete("watch-sample");
    }
    expect(await controller.sample("session-2")).toMatchObject({ sessionId: "session-2" });
    properties.set("watch-sample", Promise.reject(new MpvIpcFailure("MPV command timed out")));
    await expect(controller.sample("session-2")).rejects.toThrow("MPV command timed out");
    expect(controller.getState()).toBeNull();
  });
});


describe("native track memory", () => {
  const streams = [
    { id: "fr", kind: "audio", ordinal: 1, codec: "aac", language: "fr", title: null, isDefault: true },
    { id: "en-first", kind: "audio", ordinal: 2, codec: "aac", language: "eng", title: "Commentary", isDefault: false },
    { id: "en-last", kind: "audio", ordinal: 3, codec: "aac", language: "en", title: null, isDefault: false },
    { id: "sub", kind: "subtitle", ordinal: 4, codec: "subrip", language: "en", title: null, isDefault: true },
  ] as const satisfies PlayerSession["streams"];
  test("startup maps resolved file tracks to MPV IDs, defaults subtitles Off, and never saves", async () => {
    await withPlayback(async ({ controller, properties, saveChoice }) => {
      expect(controller.getState()).toMatchObject({ selectedAudioStreamId: "en-first", selectedSubtitleStreamId: null });
      expect(properties.get("aid")).toBe(12); expect(properties.get("sid")).toBe(false);
      expect(saveChoice).not.toHaveBeenCalled();
      await controller.selectAudioStream("session-1", "en-last");
      expect(properties.get("aid")).toBe(13);
      expect(saveChoice).toHaveBeenCalledWith("session-1", { kind: "audio", choice: "en-last" });
      await controller.selectSubtitleStream("session-1", null);
      expect(saveChoice).toHaveBeenCalledWith("session-1", { kind: "subtitle", choice: "off" });
      await controller.resetTrack("session-1", "audio");
      expect(controller.getState()?.selectedAudioStreamId).toBe("en-first");
    }, { streams });
  });
  test("revisits honor exact overrides; a failed save leaves playback active and can be retried", async () => {
    await withPlayback(async ({ controller, properties, saveChoice, restart }) => {
      expect(properties.get("aid")).toBe(13); expect(properties.get("sid")).toBe(14);
      saveChoice.mockRejectedValueOnce(new Error("offline"));
      const result = await controller.selectAudioStream("session-1", "fr");
      expect(result.selectedAudioStreamId).toBe("fr"); expect(result.trackMemoryError).toContain("Retry");
      await controller.retryTrackMemory("session-1");
      expect(controller.getState()?.trackMemoryError).toBeNull();
      await restart(); expect(controller.getState()?.selectedAudioStreamId).toBe("fr");
    }, { streams, memory: { ...defaultTrackMemory(), audio: describeTrack("source", streams[2]), subtitle: describeTrack("source", streams[3]) } });
  });
});
