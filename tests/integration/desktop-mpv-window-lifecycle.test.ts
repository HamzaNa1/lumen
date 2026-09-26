import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IpcPlayerState } from "@lumen/contracts";
import type { BrowserWindow } from "electron";
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

mock.module("electron", () => ({ BaseWindow: FakeBaseWindow, app: {}, screen: {} }));
const { MpvSurface } = await import("../../apps/desktop/src/main/player/MpvSurface");
const { PlayerController, startNativePlayer } = await import("../../apps/desktop/src/main/player/PlayerController");
const { MpvIpc } = await import("../../apps/desktop/src/main/player/MpvIpc");
const { MpvProcess } = await import("../../apps/desktop/src/main/player/MpvProcess");

const withPlayback = async (
  run: (playback: {
    controller: InstanceType<typeof PlayerController>;
    states: IpcPlayerState[];
    properties: Map<string, unknown>;
    heartbeat: ReturnType<typeof mock>;
    progress: ReturnType<typeof mock>;
  }) => Promise<void>,
): Promise<void> => {
  const startProcess = spyOn(MpvProcess, "start").mockReturnValue({
    stop: async () => undefined,
  } as unknown as MpvProcess);
  const connect = spyOn(MpvIpc.prototype, "connect").mockResolvedValue(undefined);
  const properties = new Map<string, unknown>([
    ["window-id", 1],
    ["time-pos", 12.25],
    ["duration", 60],
    ["pause", false],
    ["eof-reached", false],
  ]);
  const command = spyOn(MpvIpc.prototype, "command").mockImplementation(function (
    this: InstanceType<typeof MpvIpc>,
    args: ReadonlyArray<string | number>,
  ): Promise<unknown> {
    if (args[0] === "loadfile") queueMicrotask(() => this.emit("file-loaded"));
    return Promise.resolve(args[0] === "get_property" ? properties.get(String(args[1])) : null);
  });
  const states: IpcPlayerState[] = [];
  const heartbeat = mock(async () => undefined);
  const progress = mock(async () => undefined);
  let sessionNumber = 0;
  const client = {
    serverOrigin: "http://localhost:3000",
    startPlayback: async () => ({
      sessionId: `session-${++sessionNumber}`,
      itemId: "item-1",
      streamUrl: "/stream",
      grantToken: "grant",
      durationSeconds: 60,
      streams: [],
    }),
    request: async () => undefined,
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
    onState: (state: IpcPlayerState) => states.push(state),
  } as unknown as ConstructorParameters<typeof PlayerController>[0]);
  try {
    await controller.start({ client, connectionId: "connection-1", itemId: "item-1" } as unknown as Parameters<typeof controller.start>[0]);
    states.length = 0;
    await run({ controller, states, properties, heartbeat, progress });
  } finally {
    await controller.stop();
    startProcess.mockRestore();
    connect.mockRestore();
    command.mockRestore();
  }
};

describe("playback progress updates", () => {
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
      client: { request: async () => calls.push("delete session") },
      process: {
        stop: async () => {
          calls.push("destroy:start");
          await destroying;
          calls.push("destroy:done");
        },
      },
      ipc: { close: () => calls.push("close IPC") },
      capability: "capability-1",
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
        request: async () => calls.push("session:delete"),
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
