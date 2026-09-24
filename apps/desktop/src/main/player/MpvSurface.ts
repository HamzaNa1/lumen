import { BrowserWindow, screen } from "electron";
import type { MpvIpc } from "./MpvIpc";

export interface PlayerSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMBEDDED_PLATFORMS = new Set<NodeJS.Platform>(["win32", "linux"]);

const isFiniteInteger = (value: number): boolean =>
  Number.isFinite(value) && Number.isInteger(value);

const nativeWindowId = (handle: Buffer): string => {
  if (process.platform === "win32") return String(handle.readUInt32LE(0));
  if (handle.byteLength >= 8) return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
};

export class MpvSurface {
  private readonly parent: BrowserWindow;
  private host: BrowserWindow | null = null;
  private bounds: PlayerSurfaceBounds | null = null;
  private ipc: MpvIpc | null = null;
  private playbackVisible = false;

  constructor(parent: BrowserWindow) {
    this.parent = parent;
    const sync = (): void => {
      this.syncHostBounds();
      if (process.platform === "darwin" && this.ipc !== null) {
        void this.syncPlaybackWindow(this.ipc).catch(() => undefined);
      }
    };
    parent.on("move", sync);
    parent.on("resize", sync);
    parent.on("restore", () => this.setParentVisible(true));
    parent.on("focus", () => this.setParentVisible(true));
    parent.on("minimize", () => this.setParentVisible(false));
    parent.on("blur", () => this.setParentVisible(false));
    parent.on("show", () => this.setParentVisible(true));
    parent.once("closed", () => this.dispose());
  }

  setBounds(bounds: PlayerSurfaceBounds | null): void {
    if (bounds !== null) {
      const [contentWidth, contentHeight] = this.parent.getContentSize();
      if (
        !isFiniteInteger(bounds.x) ||
        !isFiniteInteger(bounds.y) ||
        !isFiniteInteger(bounds.width) ||
        !isFiniteInteger(bounds.height) ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.width < 1 ||
        bounds.height < 1 ||
        bounds.x + bounds.width > contentWidth + 1 ||
        bounds.y + bounds.height > contentHeight + 1
      ) {
        throw new Error("Invalid player surface bounds");
      }
    }
    this.bounds = bounds;
    if (bounds === null) {
      this.playbackVisible = false;
      this.host?.hide();
    } else this.syncHostBounds();
  }

  prepare(): ReadonlyArray<string> {
    if (this.bounds === null) throw new Error("The in-app player surface is not ready");
    this.playbackVisible = true;
    if (!EMBEDDED_PLATFORMS.has(process.platform)) return this.overlayArguments();
    const host = this.ensureHost();
    this.syncHostBounds();
    host.showInactive();
    return [`--wid=${nativeWindowId(host.getNativeWindowHandle())}`];
  }

  async syncPlaybackWindow(ipc: MpvIpc): Promise<void> {
    this.ipc = ipc;
    if (this.bounds === null) {
      this.playbackVisible = false;
      if (process.platform === "darwin") {
        await ipc.command(["set_property", "window-minimized", "yes"]);
      } else {
        this.host?.hide();
      }
      return;
    }
    this.playbackVisible = true;
    if (process.platform === "darwin") {
      await ipc.command(["set_property", "options/geometry", this.geometry()]);
      await ipc.command(["set_property", "window-minimized", "no"]);
    } else {
      this.syncHostBounds();
      this.host?.showInactive();
    }
  }

  hide(): void {
    this.playbackVisible = false;
    this.host?.hide();
  }

  detach(): void {
    this.ipc = null;
    this.hide();
  }

  dispose(): void {
    if (this.host !== null && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
    this.ipc = null;
    this.playbackVisible = false;
  }

  private ensureHost(): BrowserWindow {
    if (this.host !== null && !this.host.isDestroyed()) return this.host;
    const host = new BrowserWindow({
      parent: this.parent,
      frame: false,
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      backgroundColor: "#000000",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    host.setMenuBarVisibility(false);
    host.webContents.setAudioMuted(true);
    this.host = host;
    return host;
  }

  private syncHostBounds(): void {
    if (this.bounds === null || this.host === null || this.host.isDestroyed()) return;
    const parentBounds = this.parent.getContentBounds();
    this.host.setBounds({
      x: parentBounds.x + this.bounds.x,
      y: parentBounds.y + this.bounds.y,
      width: this.bounds.width,
      height: this.bounds.height,
    });
  }

  private overlayArguments(): ReadonlyArray<string> {
    if (process.platform !== "darwin") {
      throw new Error("Embedded MPV requires Win32 or an X11-compatible Linux session");
    }
    return [
      "--no-border",
      "--title-bar=no",
      "--no-window-dragging",
      "--input-default-bindings=no",
      "--input-vo-keyboard=no",
      "--cursor-autohide=always",
      "--auto-window-resize=no",
      "--keepaspect-window=no",
      "--force-window-position=yes",
      "--focus-on=never",
      "--ontop",
      "--ontop-level=window",
      "--macos-app-activation-policy=prohibited",
      "--macos-geometry-calculation=whole",
      `--geometry=${this.geometry()}`,
    ];
  }

  private geometry(): string {
    if (this.bounds === null) throw new Error("The in-app player surface is not ready");
    const content = this.parent.getContentBounds();
    const absolute = {
      x: content.x + this.bounds.x,
      y: content.y + this.bounds.y,
      width: this.bounds.width,
      height: this.bounds.height,
    };
    const display = screen.getDisplayMatching(absolute);
    const x = absolute.x - display.bounds.x;
    const y = display.bounds.y + display.bounds.height - absolute.y - absolute.height;
    return `${absolute.width}x${absolute.height}+${Math.round(x)}+${Math.round(y)}`;
  }

  private setParentVisible(visible: boolean): void {
    if (!this.playbackVisible) return;
    if (process.platform === "darwin" && this.ipc !== null) {
      void this.ipc
        .command(["set_property", "window-minimized", visible ? "no" : "yes"])
        .catch(() => undefined);
      if (visible) void this.syncPlaybackWindow(this.ipc).catch(() => undefined);
      return;
    }
    if (visible) this.host?.showInactive();
    else this.host?.hide();
  }
}
