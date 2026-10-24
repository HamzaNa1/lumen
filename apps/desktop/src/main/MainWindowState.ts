import { Schema } from "effect";
import type { BrowserWindow, Rectangle } from "electron";
import { JsonFileStore } from "./storage/JsonFileStore";

export const mainWindowDefaultSize = { width: 1440, height: 920 } as const;
export const mainWindowMinimumSize = { width: 1024, height: 680 } as const;

const WindowBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
});

const MainWindowState = Schema.Struct({
  /** The window's size and position when neither maximized nor fullscreen. */
  bounds: Schema.NullOr(WindowBounds),
  maximized: Schema.Boolean,
});
export type MainWindowState = Schema.Schema.Type<typeof MainWindowState>;

export const openMainWindowState = (path: string): Promise<JsonFileStore<MainWindowState>> =>
  JsonFileStore.open({
    path,
    schema: MainWindowState,
    defaults: () => ({ bounds: null, maximized: false }),
    name: "main window state",
  });

export interface DisplayWorkAreas {
  readonly primary: Rectangle;
  readonly all: readonly Rectangle[];
}

const overlapArea = (a: Rectangle, b: Rectangle): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the main window opens: its last bounds, kept whole on the display it mostly
 * covered. A window whose display is gone opens at its last size, centered on the primary.
 */
export const placeMainWindow = (state: MainWindowState, displays: DisplayWorkAreas): Rectangle => {
  const saved = state.bounds;
  let area = displays.primary;
  let centered = true;
  if (saved !== null) {
    let largest = 0;
    for (const candidate of displays.all) {
      const overlap = overlapArea(saved, candidate);
      if (overlap > largest) {
        largest = overlap;
        area = candidate;
        centered = false;
      }
    }
  }
  const requested = saved ?? mainWindowDefaultSize;
  const width = clamp(requested.width, mainWindowMinimumSize.width, area.width);
  const height = clamp(requested.height, mainWindowMinimumSize.height, area.height);
  if (saved === null || centered) {
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    };
  }
  return {
    x: clamp(saved.x, area.x, area.x + area.width - width),
    y: clamp(saved.y, area.y, area.y + area.height - height),
    width,
    height,
  };
};

const sameState = (a: MainWindowState, b: MainWindowState): boolean =>
  a.maximized === b.maximized &&
  a.bounds?.x === b.bounds?.x &&
  a.bounds?.y === b.bounds?.y &&
  a.bounds?.width === b.bounds?.width &&
  a.bounds?.height === b.bounds?.height;

/** Keeps the window's size, position and maximized state for its next launch. */
export const rememberMainWindowState = (
  window: BrowserWindow,
  store: JsonFileStore<MainWindowState>,
): void => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const save = (): void => {
    cancel();
    // Fullscreen is the player's, and a minimized window has no size worth keeping.
    if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
    const state = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    if (!sameState(state, store.current)) store.set(state);
  };
  // Saved while the viewer arranges the window, so a quit cannot outrun the write.
  const schedule = (): void => {
    cancel();
    timer = setTimeout(save, 300);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", cancel);
  window.on("close", save);
  window.once("closed", cancel);
};
