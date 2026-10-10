import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { observeFullscreenState } from "../../packages/app/src/FullscreenState";
import { electronTestExports } from "../helpers/electron";

mock.module("electron", () => electronTestExports);
const { broadcastPlayerFullscreen } = await import(
  "../../apps/desktop/src/main/player/PlayerWindowState"
);

class FullscreenWindow extends EventEmitter {
  fullscreen = false;
  destroyed = false;
  readonly messages: boolean[] = [];
  readonly webContents = {
    send: (channel: string, value: boolean) => {
      expect(this.destroyed).toBe(false);
      this.messages.push(value);
      this.emit(channel, value);
    },
  };

  constructor(private readonly eventBeforeState = false) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  setFullScreen(enabled: boolean): void {
    if (this.eventBeforeState) this.emit(enabled ? "enter-full-screen" : "leave-full-screen");
    this.fullscreen = enabled;
    if (!this.eventBeforeState) this.emit(enabled ? "enter-full-screen" : "leave-full-screen");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }

  onFullscreenChange = (callback: (fullscreen: boolean) => void): (() => void) => {
    this.on("player:fullscreen-state", callback);
    return () => {
      this.off("player:fullscreen-state", callback);
    };
  };

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

test("each toggle changes fullscreen once when Windows emits events before updating its state", async () => {
  const parent = new FullscreenWindow(true);
  const overlay = new FullscreenWindow();
  const stopBroadcast = broadcastPlayerFullscreen(parent.asBrowserWindow(), overlay.asBrowserWindow());
  const states = [[], []] as [boolean[], boolean[]];
  const unsubscribe = [parent, overlay].map((window, index) =>
    observeFullscreenState({
      fullscreenState: async () => parent.isFullScreen(),
      onFullscreenChange: window.onFullscreenChange,
    }, (value) => states[index]?.push(value)),
  );
  await Promise.resolve();

  try {
    for (const expected of [true, false, true, false]) {
      parent.setFullScreen(!states[1].at(-1));
      expect(parent.isFullScreen()).toBe(expected);
      expect(states[0].at(-1)).toBe(expected);
      expect(states[1].at(-1)).toBe(expected);
    }
    // Repeated requests also emit events on Windows, even if already in that state.
    parent.setFullScreen(false);
    expect(states).toEqual([
      [false, true, false, true, false, false],
      [false, true, false, true, false, false],
    ]);
  } finally {
    for (const dispose of unsubscribe) dispose();
    stopBroadcast();
  }
});

test("both renderers follow fullscreen changes, including exiting playback and reusing the controls", async () => {
  const parent = new FullscreenWindow();
  const overlay = new FullscreenWindow();
  const stopBroadcast = broadcastPlayerFullscreen(parent.asBrowserWindow(), overlay.asBrowserWindow());
  const states = [[], []] as [boolean[], boolean[]];
  const unsubscribe = [parent, overlay].map((window, index) =>
    observeFullscreenState({
      fullscreenState: async () => parent.isFullScreen(),
      onFullscreenChange: window.onFullscreenChange,
    }, (value) => states[index]?.push(value)),
  );
  await Promise.resolve();

  parent.setFullScreen(true);
  // Back exits fullscreen from the main renderer; the controls stay mounted between videos.
  parent.setFullScreen(false);
  expect(states).toEqual([[false, true, false], [false, true, false]]);
  // The next click enters fullscreen instead of using the previous video's stale state.
  parent.setFullScreen(!states[1].at(-1));
  expect(states).toEqual([[false, true, false, true], [false, true, false, true]]);

  for (const dispose of unsubscribe) dispose();
  stopBroadcast();
});

test("fullscreen broadcasts tolerate a destroyed overlay and stop when the parent closes", () => {
  const parent = new FullscreenWindow();
  const overlay = new FullscreenWindow();
  const dispose = broadcastPlayerFullscreen(parent.asBrowserWindow(), overlay.asBrowserWindow());
  overlay.destroy();
  parent.setFullScreen(true);
  expect(parent.messages).toEqual([true]);
  expect(overlay.messages).toEqual([]);
  parent.destroy();
  expect(parent.listenerCount("enter-full-screen")).toBe(0);
  expect(parent.listenerCount("leave-full-screen")).toBe(0);
  dispose();
});

test("a late initial fullscreen reply cannot overwrite newer window events", async () => {
  const window = new FullscreenWindow();
  const snapshot = Promise.withResolvers<boolean>();
  const states: boolean[] = [];
  const dispose = observeFullscreenState({
    fullscreenState: () => snapshot.promise,
    onFullscreenChange: window.onFullscreenChange,
  }, (value) => states.push(value));
  window.webContents.send("player:fullscreen-state", true);
  window.webContents.send("player:fullscreen-state", false);
  snapshot.resolve(true);
  await snapshot.promise;
  expect(states).toEqual([true, false]);
  dispose();
});

test("an unmounted fullscreen observer ignores pending replies and unsubscribes", async () => {
  const window = new FullscreenWindow();
  const snapshot = Promise.withResolvers<boolean>();
  const states: boolean[] = [];
  const dispose = observeFullscreenState({
    fullscreenState: () => snapshot.promise,
    onFullscreenChange: window.onFullscreenChange,
  }, (value) => states.push(value));
  dispose();
  snapshot.resolve(true);
  window.webContents.send("player:fullscreen-state", true);
  await snapshot.promise;
  expect(states).toEqual([]);
  expect(window.listenerCount("player:fullscreen-state")).toBe(0);
});

test("fullscreen events still update the controls if the initial state request fails", async () => {
  const window = new FullscreenWindow();
  const snapshot = Promise.reject(new Error("Window is starting"));
  const states: boolean[] = [];
  const dispose = observeFullscreenState({
    fullscreenState: () => snapshot,
    onFullscreenChange: window.onFullscreenChange,
  }, (value) => states.push(value));
  await snapshot.catch(() => undefined);
  window.webContents.send("player:fullscreen-state", true);
  expect(states).toEqual([true]);
  dispose();
});
