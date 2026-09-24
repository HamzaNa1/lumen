import type { IpcPlayerSurfaceBounds } from "@lumen/contracts";
import { BaseWindow, type BrowserWindow } from "electron";
import { MacMpvWindow } from "./MacMpvWindow";

const nativeWindowId = (handle: Buffer): string => {
  if (process.platform === "win32") return String(handle.readUInt32LE(0));
  if (handle.byteLength >= 8) return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
};

export class MpvSurface {
  private readonly parent: BrowserWindow;
  private host: BaseWindow | null = null;
  private macWindow: MacMpvWindow | null = null;
  private bounds: IpcPlayerSurfaceBounds | null = null;
  private playbackVisible = false;

  constructor(parent: BrowserWindow) {
    this.parent = parent;
    parent.on("move", () => this.syncHostBounds());
    parent.on("resize", () => this.syncHostBounds());
    parent.on("restore", () => this.show());
    parent.on("focus", () => this.show());
    parent.on("minimize", () => this.host?.hide());
    parent.on("blur", () => this.host?.hide());
    parent.on("show", () => this.show());
    parent.once("closed", () => this.dispose());
  }

  setBounds(bounds: IpcPlayerSurfaceBounds | null): void {
    if (bounds !== null) {
      const [contentWidth, contentHeight] = this.parent.getContentSize();
      if (
        bounds.x + bounds.width > contentWidth + 1 ||
        bounds.y + bounds.height > contentHeight + 1
      ) {
        throw new Error("Player surface exceeds the app window");
      }
    }
    this.bounds = bounds;
    if (bounds === null) this.host?.hide();
    else this.syncHostBounds();
  }

  prepare(): ReadonlyArray<string> {
    if (this.bounds === null) throw new Error("The in-app player surface is not ready");
    const host = this.ensureHost();
    this.playbackVisible = true;
    this.syncHostBounds();
    host.showInactive();
    if (process.platform === "darwin") return [];
    return [`--wid=${nativeWindowId(host.getNativeWindowHandle())}`];
  }

  attachNativeWindow(windowId: number): void {
    if (process.platform !== "darwin") return;
    this.macWindow?.dispose();
    const host = this.ensureHost();
    this.macWindow = new MacMpvWindow(
      BigInt(nativeWindowId(host.getNativeWindowHandle())),
      BigInt(Math.trunc(windowId)),
    );
  }

  show(): void {
    if (this.bounds === null || !this.playbackVisible) return;
    this.syncHostBounds();
    this.host?.showInactive();
  }

  hide(): void {
    this.playbackVisible = false;
    this.macWindow?.dispose();
    this.macWindow = null;
    this.host?.hide();
  }

  dispose(): void {
    this.playbackVisible = false;
    this.macWindow?.dispose();
    this.macWindow = null;
    if (this.host !== null && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
  }

  private ensureHost(): BaseWindow {
    if (this.host !== null && !this.host.isDestroyed()) return this.host;
    const host = new BaseWindow({
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
    });
    host.setMenuBarVisibility(false);
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
    this.macWindow?.sync();
  }
}
