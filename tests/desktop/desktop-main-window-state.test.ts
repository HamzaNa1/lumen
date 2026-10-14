import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";
import {
  type MainWindowState,
  openMainWindowState,
  placeMainWindow,
  rememberMainWindowState,
} from "../../apps/desktop/src/main/MainWindowState";

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const monitor = { x: 1512, y: -300, width: 2560, height: 1415 };
const displays = { primary: laptop, all: [laptop, monitor] };

const withStateFile = async (run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "main-window-state-"));
  try {
    await run(join(directory, "main-window-state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const waitForStored = async (path: string, expected: MainWindowState): Promise<void> => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const stored: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
    if (Bun.deepEquals(stored, expected)) return;
    if (Date.now() >= deadline) expect(stored).toEqual(expected);
    await Bun.sleep(10);
  }
};

class FakeWindow extends EventEmitter {
  bounds: Rectangle = { x: 0, y: 0, width: 1440, height: 920 };
  normalBounds: Rectangle | null = null;
  maximized = false;
  fullscreen = false;
  minimized = false;

  isDestroyed = (): boolean => false;
  isFullScreen = (): boolean => this.fullscreen;
  isMinimized = (): boolean => this.minimized;
  isMaximized = (): boolean => this.maximized;
  getNormalBounds = (): Rectangle => this.normalBounds ?? this.bounds;

  resizeTo(bounds: Rectangle): void {
    this.bounds = bounds;
    this.emit("resize");
  }
}

describe("main window placement", () => {
  test("the first launch opens at the default size, centered on the primary display", () => {
    expect(placeMainWindow({ bounds: null, maximized: false }, displays)).toEqual({
      x: 36,
      y: 25,
      width: 1440,
      height: 920,
    });
  });

  test("a window opens where it was last left", () => {
    const bounds = { x: 1700, y: -200, width: 1900, height: 1200 };
    expect(placeMainWindow({ bounds, maximized: false }, displays)).toEqual(bounds);
  });

  test("a window hanging off its display is pulled back onto it", () => {
    expect(
      placeMainWindow(
        { bounds: { x: 3500, y: 900, width: 1200, height: 800 }, maximized: false },
        displays,
      ),
    ).toEqual({ x: 2872, y: 315, width: 1200, height: 800 });
  });

  test("a window larger than its display shrinks to fit it", () => {
    expect(
      placeMainWindow(
        { bounds: { x: 0, y: 0, width: 3000, height: 2000 }, maximized: false },
        { primary: laptop, all: [laptop] },
      ),
    ).toEqual(laptop);
  });

  test("a window whose display is gone keeps its size on the primary display", () => {
    expect(
      placeMainWindow(
        { bounds: { x: 1700, y: -200, width: 1200, height: 800 }, maximized: false },
        { primary: laptop, all: [laptop] },
      ),
    ).toEqual({ x: 156, y: 85, width: 1200, height: 800 });
  });

  test("a window saved below the minimum size opens at the minimum", () => {
    expect(
      placeMainWindow(
        { bounds: { x: 100, y: 100, width: 400, height: 300 }, maximized: false },
        displays,
      ),
    ).toEqual({ x: 100, y: 100, width: 1024, height: 680 });
  });
});

describe("main window state", () => {
  test("a resized window opens at that size the next time the app starts", () =>
    withStateFile(async (path) => {
      const store = await openMainWindowState(path);
      expect(store.current).toEqual({ bounds: null, maximized: false });
      const window = new FakeWindow();
      rememberMainWindowState(window as unknown as BrowserWindow, store);
      for (let width = 1100; width <= 1800; width += 100) {
        window.resizeTo({ x: 40, y: 60, width, height: 1000 });
      }
      const expected = { bounds: { x: 40, y: 60, width: 1800, height: 1000 }, maximized: false };
      await waitForStored(path, expected);
      expect((await openMainWindowState(path)).current).toEqual(expected);
    }));

  test("a maximized window keeps the size it restores to", () =>
    withStateFile(async (path) => {
      const store = await openMainWindowState(path);
      const window = new FakeWindow();
      rememberMainWindowState(window as unknown as BrowserWindow, store);
      window.normalBounds = { x: 200, y: 100, width: 1300, height: 800 };
      window.maximized = true;
      window.bounds = monitor;
      window.emit("maximize");
      window.emit("close");
      await waitForStored(path, { bounds: window.normalBounds, maximized: true });
    }));

  test("fullscreen and minimized windows leave the last kept state alone", () =>
    withStateFile(async (path) => {
      const store = await openMainWindowState(path);
      const window = new FakeWindow();
      rememberMainWindowState(window as unknown as BrowserWindow, store);
      const kept = { bounds: { x: 10, y: 20, width: 1300, height: 800 }, maximized: false };
      window.resizeTo(kept.bounds);
      window.emit("close");
      await waitForStored(path, kept);
      window.fullscreen = true;
      window.emit("enter-full-screen");
      window.resizeTo(monitor);
      window.emit("close");
      window.fullscreen = false;
      window.minimized = true;
      window.resizeTo({ x: 0, y: 0, width: 160, height: 28 });
      window.emit("close");
      await Bun.sleep(400);
      expect(store.current).toEqual(kept);
      await waitForStored(path, kept);
    }));

  test("a state file that cannot be read opens the window at the default size", () =>
    withStateFile(async (path) => {
      await writeFile(path, JSON.stringify({ bounds: { x: "left" }, maximized: false }));
      expect((await openMainWindowState(path)).current).toEqual({
        bounds: null,
        maximized: false,
      });
    }));
});
