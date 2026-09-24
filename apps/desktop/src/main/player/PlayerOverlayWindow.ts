import { BrowserWindow } from "electron";
import { MacPlayerFocus } from "./MacPlayerFocus";

export class PlayerOverlayWindow {
  readonly window: BrowserWindow;
  private visible = false;

  constructor(
    private readonly parent: BrowserWindow,
    preloadPath: string,
  ) {
    this.window = new BrowserWindow({
      parent,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      backgroundColor: "#00000000",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: preloadPath,
      },
    });
    if (process.platform === "darwin") {
      const focus = new MacPlayerFocus(parent.getNativeWindowHandle());
      this.window.on("focus", () => {
        // AppKit finishes promoting the key window after Electron's focus event.
        setImmediate(() => {
          if (!parent.isDestroyed() && !this.window.isDestroyed() && this.window.isFocused()) {
            focus.restoreMainWindow();
          }
        });
      });
      this.window.once("closed", () => focus.dispose());
    }
    parent.on("move", () => this.sync());
    parent.on("resize", () => this.sync());
    parent.on("enter-full-screen", () => this.sync());
    parent.on("leave-full-screen", () => this.sync());
    parent.on("minimize", () => this.window.hide());
    parent.on("restore", () => this.show());
    parent.on("focus", () => this.show());
    parent.once("closed", () => this.window.destroy());
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event, url) => {
      if (url !== this.window.webContents.getURL()) event.preventDefault();
    });
  }

  async load(rendererUrl: string | undefined, rendererFile: string): Promise<void> {
    if (rendererUrl !== undefined) {
      const url = new URL(rendererUrl);
      url.searchParams.set("overlay", "1");
      await this.window.loadURL(url.toString());
    } else {
      await this.window.loadFile(rendererFile, { query: { overlay: "1" } });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.show();
    else this.window.hide();
  }

  moveAboveVideo(): void {
    if (this.window.isVisible()) this.window.moveTop();
  }

  private show(): void {
    if (!this.visible || this.parent.isMinimized() || !this.parent.isVisible()) return;
    this.sync();
    this.window.showInactive();
    this.moveAboveVideo();
  }

  private sync(): void {
    if (this.window.isDestroyed()) return;
    this.window.setBounds(this.parent.getContentBounds());
    if (this.visible) this.moveAboveVideo();
  }
}
