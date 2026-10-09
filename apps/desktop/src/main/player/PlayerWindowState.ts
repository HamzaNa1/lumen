import { type BrowserWindow, type Rectangle, screen } from "electron";

export const playerContentBounds = (parent: BrowserWindow): Rectangle => {
  // Chromium shrinks a background fullscreen HWND by one physical pixel without
  // resizing its renderer. The video and controls must keep the renderer's full
  // monitor viewport, including when the controls window holds focus.
  if (process.platform === "win32" && parent.isFullScreen()) {
    return screen.getDisplayMatching(parent.getBounds()).bounds;
  }
  return parent.getContentBounds();
};

export const observePlayerFocus = (
  parent: BrowserWindow,
  overlay: BrowserWindow | undefined,
  onChange: (focused: boolean) => void,
): (() => void) => {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    // Electron emits focus before Chromium finishes its native activation and
    // fullscreen bounds changes. Coalesce parent/controls handoffs after that.
    timer = setTimeout(() => {
      timer = null;
      if (disposed || parent.isDestroyed()) return;
      onChange(
        parent.isFocused() ||
          (overlay !== undefined && !overlay.isDestroyed() && overlay.isFocused()),
      );
    }, 0);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const window of [parent, overlay]) {
      window?.off("focus", changed);
      window?.off("blur", changed);
      window?.off("closed", dispose);
    }
  };
  for (const window of [parent, overlay]) {
    window?.on("focus", changed);
    window?.on("blur", changed);
    window?.once("closed", dispose);
  }
  return dispose;
};
