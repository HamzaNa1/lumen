import type { IpcPlayerSurfaceBounds } from "@lumen/contracts";
import { BaseWindow, type BrowserWindow } from "electron";
import { MacMpvWindow } from "./MacMpvWindow";
import type { PlayerOverlayWindow } from "./PlayerOverlayWindow";
import { WindowsMpvHost } from "./WindowsMpvHost";

type NativeVideoWindow = Pick<MacMpvWindow, "sync" | "show" | "dispose">;
type CreateNativeVideoWindow = (hostView: bigint, windowId: bigint) => NativeVideoWindow;
type VideoHost = Pick<
  BaseWindow,
  "getNativeWindowHandle" | "setBounds" | "showInactive" | "hide" | "isDestroyed" | "destroy"
>;

const nativeWindowId = (handle: Buffer): string => {
  if (process.platform === "win32") return String(handle.readUInt32LE(0));
  if (handle.byteLength >= 8) return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
};

export class MpvSurface {
  private readonly parent: BrowserWindow;
  private host: VideoHost | null = null;
  private macWindow: NativeVideoWindow | null = null;
  private bounds: IpcPlayerSurfaceBounds | null = null;
  private playbackVisible = false;
  private readonly overlay?: PlayerOverlayWindow;
  private readonly createNativeVideoWindow: CreateNativeVideoWindow;
  private disposed = false;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onBoundsChanged = (): void => this.syncHostBounds();
  private readonly onShow = (): void => this.show();
  private readonly onMinimize = (): void => this.hideHost();
  private readonly onClosed = (): void => this.dispose();
  private readonly onFocusChanged = (): void => {
    if (this.disposed) return;
    if (this.focusTimer !== null) clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      // A blur event can be the last event before either window is destroyed.
      // Even a callback already queued by the event loop must be harmless.
      if (this.disposed || this.parent.isDestroyed()) return;
      const overlay = this.overlay?.window;
      if (
        this.parent.isFocused() ||
        (overlay !== undefined && !overlay.isDestroyed() && overlay.isFocused())
      )
        this.show();
      else this.hideHost();
    }, 0);
  };

  constructor(
    parent: BrowserWindow,
    overlay?: PlayerOverlayWindow,
    createNativeVideoWindow: CreateNativeVideoWindow = (hostView, windowId) =>
      new MacMpvWindow(hostView, windowId),
  ) {
    this.parent = parent;
    this.overlay = overlay;
    this.createNativeVideoWindow = createNativeVideoWindow;
    parent.on("move", this.onBoundsChanged);
    parent.on("resize", this.onBoundsChanged);
    parent.on("restore", this.onShow);
    parent.on("focus", this.onShow);
    parent.on("minimize", this.onMinimize);
    parent.on("blur", this.onFocusChanged);
    overlay?.window.on("focus", this.onFocusChanged);
    overlay?.window.on("blur", this.onFocusChanged);
    parent.on("show", this.onShow);
    parent.once("closed", this.onClosed);
  }

  setBounds(bounds: IpcPlayerSurfaceBounds | null): void {
    if (this.disposed || this.parent.isDestroyed()) return;
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
    if (bounds === null) this.hideHost();
    else if (this.playbackVisible) this.show();
    else this.syncHostBounds();
  }

  prepare(): ReadonlyArray<string> {
    if (this.disposed || this.parent.isDestroyed()) throw new Error("The player window is closed");
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
    if (!this.playbackVisible || this.macWindow !== null)
      throw new Error("The MPV video window is already attached or playback has stopped");
    const host = this.ensureHost();
    this.macWindow = this.createNativeVideoWindow(
      BigInt(nativeWindowId(host.getNativeWindowHandle())),
      BigInt(Math.trunc(windowId)),
    );
  }

  show(): void {
    if (this.disposed || this.parent.isDestroyed() || this.bounds === null || !this.playbackVisible)
      return;
    this.syncHostBounds();
    if (this.host !== null && !this.host.isDestroyed()) this.host.showInactive();
    this.macWindow?.show();
    this.overlay?.moveAboveVideo();
  }

  hide(): void {
    this.playbackVisible = false;
    this.hideHost();
    this.detachNativeWindow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.focusTimer !== null) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.parent.off("move", this.onBoundsChanged);
    this.parent.off("resize", this.onBoundsChanged);
    this.parent.off("restore", this.onShow);
    this.parent.off("focus", this.onShow);
    this.parent.off("minimize", this.onMinimize);
    this.parent.off("blur", this.onFocusChanged);
    this.parent.off("show", this.onShow);
    this.parent.off("closed", this.onClosed);
    this.overlay?.window.off("focus", this.onFocusChanged);
    this.overlay?.window.off("blur", this.onFocusChanged);
    this.hide();
    if (this.host !== null && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
    this.bounds = null;
  }

  private hideHost(): void {
    if (this.host !== null && !this.host.isDestroyed()) this.host.hide();
  }

  private detachNativeWindow(): void {
    const window = this.macWindow;
    this.macWindow = null;
    window?.dispose();
  }

  private ensureHost(): VideoHost {
    if (this.host !== null && !this.host.isDestroyed()) return this.host;
    if (process.platform === "win32") {
      this.host = new WindowsMpvHost(this.parent);
      return this.host;
    }
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
    if (process.platform === "darwin") host.setIgnoreMouseEvents(true);
    this.host = host;
    return host;
  }

  private syncHostBounds(): void {
    if (
      this.disposed ||
      this.parent.isDestroyed() ||
      this.bounds === null ||
      this.host === null ||
      this.host.isDestroyed()
    )
      return;
    const parentBounds = this.parent.getContentBounds();
    this.host.setBounds({
      x: parentBounds.x + this.bounds.x,
      y: parentBounds.y + this.bounds.y,
      width: this.bounds.width,
      height: this.bounds.height,
    });
    this.macWindow?.sync();
    this.overlay?.moveAboveVideo();
  }
}
