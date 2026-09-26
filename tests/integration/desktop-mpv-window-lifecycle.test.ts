import { describe, expect, mock, spyOn, test } from "bun:test";
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
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

mock.module("electron", () => ({ BaseWindow: FakeBaseWindow, app: {}, screen: {} }));
const { MpvSurface } = await import("../../apps/desktop/src/main/player/MpvSurface");
const { PlayerController } = await import("../../apps/desktop/src/main/player/PlayerController");
const { MpvIpc } = await import("../../apps/desktop/src/main/player/MpvIpc");
const { MpvProcess } = await import("../../apps/desktop/src/main/player/MpvProcess");

describe("macOS MPV window lifecycle", () => {
  test.skipIf(process.platform !== "darwin")("play, Back, and immediate replay attach and detach once per session", () => {
    events.length = 0;
    const parent = {
      on: () => undefined,
      once: () => undefined,
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
