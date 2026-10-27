import { BaseWindow, type BrowserWindow, type Rectangle, screen } from "electron";

export const broadcastPlayerFullscreen = (
  parent: BrowserWindow,
  overlay: BrowserWindow,
): (() => void) => {
  const changed = (fullscreen: boolean): void => {
    if (parent.isDestroyed()) return;
    for (const window of [parent, overlay]) {
      if (!window.isDestroyed()) window.webContents.send("player:fullscreen-state", fullscreen);
    }
  };
  // Windows emits these events before isFullScreen() reflects the new state.
  const entered = (): void => changed(true);
  const left = (): void => changed(false);
  const dispose = (): void => {
    parent.off("enter-full-screen", entered);
    parent.off("leave-full-screen", left);
    parent.off("closed", dispose);
  };
  parent.on("enter-full-screen", entered);
  parent.on("leave-full-screen", left);
  parent.once("closed", dispose);
  return dispose;
};

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

/** Serialize transitions so rapid toggles cannot strand Cocoa's child windows in another Space. */
export const playerFullscreen = (
  parent: BrowserWindow,
): ((enabled: boolean) => Promise<boolean>) => {
  let pending: Promise<boolean> = Promise.resolve(parent.isFullScreen());
  return (enabled) => {
    pending = pending
      .catch(() => false)
      .then(async () => {
        // Cocoa must finish its delegate callback before another transition or reparenting.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (parent.isDestroyed()) throw new Error("The player window is closed");
        if (parent.isFullScreen() === enabled) return enabled;
        // BrowserWindow.getChildWindows omits the BaseWindow hosting native video.
        const children =
          process.platform === "darwin"
            ? BaseWindow.getAllWindows().filter(
                (child) => child.getParentWindow()?.id === parent.id,
              )
            : [];
        for (const child of children) child.setParentWindow(null);
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            parent.off("enter-full-screen", completed);
            parent.off("leave-full-screen", completed);
            parent.off("closed", closed);
            if (!parent.isDestroyed())
              for (const child of children) if (!child.isDestroyed()) child.setParentWindow(parent);
          };
          const completed = () => {
            setImmediate(() => {
              cleanup();
              resolve();
            });
          };
          const closed = () => {
            cleanup();
            reject(new Error("The player window is closed"));
          };
          if (enabled) parent.once("enter-full-screen", completed);
          else parent.once("leave-full-screen", completed);
          parent.once("closed", closed);
          try {
            parent.setFullScreen(enabled);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
        return enabled;
      });
    return pending;
  };
};
