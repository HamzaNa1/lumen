import type { IpcPlayerSurfaceBounds } from "@lumen/contracts";
import { app, type BrowserWindow, ipcMain, screen, sharedTexture } from "electron";
import { type HelperFrame, validateTextureSize } from "./HelperFrames";
import type { MpvProcess } from "./MpvProcess";
import { WindowsTextureHandles } from "./WindowsTextureHandles";

export class CompositorSurface {
  readonly kind = "compositor" as const;
  private readonly contents: Electron.WebContents;
  private bounds: IpcPlayerSurfaceBounds | null = null;
  private generation = 0;
  private player: MpvProcess | null = null;
  private failure: ((error: Error) => void) | null = null;
  private readonly handles = new WindowsTextureHandles();
  private presented: (() => void) | null = null;
  private rejectPresentation: ((cause: Error) => void) | null = null;
  private presentation: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly window: BrowserWindow) {
    this.contents = window.webContents;
    ipcMain.on("video:status", this.status);
    this.contents.on("render-process-gone", this.lost);
    this.contents.on("did-start-loading", this.lost);
    this.contents.on("destroyed", this.lost);
    app.on("child-process-gone", this.childGone);
    window.on("move", this.resize);
    this.contents.on("zoom-changed", this.resize);
    window.once("closed", () => this.dispose());
  }

  private readonly status = (
    event: Electron.IpcMainEvent,
    generation: unknown,
    error: unknown,
  ): void => {
    if (
      event.sender !== this.contents ||
      event.senderFrame !== this.contents.mainFrame ||
      generation !== this.generation
    )
      return;
    if (typeof error === "string") this.fail(new Error(error.slice(0, 1024)));
    else {
      clearTimeout(this.timer);
      this.presented?.();
      this.presented = null;
    }
  };
  private readonly lost = (): void => {
    this.bounds = null;
    this.fail(new Error("The video renderer was closed or reloaded"));
  };
  private readonly childGone = (_event: Electron.Event, details: Electron.Details): void => {
    if (details.type === "GPU") this.fail(new Error("The video GPU process exited"));
  };

  setBounds(bounds: IpcPlayerSurfaceBounds | null): void {
    this.bounds = bounds;
    if (bounds === null) {
      this.fail(new Error("The video surface was unmounted"));
      return;
    }
    try {
      const size = this.size();
      this.player?.frames?.resize(size.width, size.height);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    }
  }

  private readonly resize = (): void => {
    if (!this.player || !this.bounds) return;
    try {
      const { width, height } = this.size();
      this.player.frames?.resize(width, height);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  private size(): { width: number; height: number } {
    if (!this.bounds) throw new Error("The video surface is not mounted");
    const scale =
      screen.getDisplayMatching(this.window.getBounds()).scaleFactor *
      this.contents.getZoomFactor();
    const width = Math.round(this.bounds.width * scale);
    const height = Math.round(this.bounds.height * scale);
    validateTextureSize(width, height);
    return { width, height };
  }

  prepare(): ReadonlyArray<string> {
    const { width, height } = this.size();
    this.generation++;
    this.contents.send("video:generation", this.generation);
    this.presentation = new Promise((resolve, reject) => {
      this.presented = resolve;
      this.rejectPresentation = reject;
    });
    void this.presentation.catch(() => undefined);
    this.timer = setTimeout(() => this.fail(new Error("No video frame was presented")), 15000);
    return [`--lumen-width=${width}`, `--lumen-height=${height}`];
  }

  connect(player: MpvProcess, failure: (error: Error) => void): void {
    this.player = player;
    this.failure = failure;
  }

  async frame(frame: HelperFrame): Promise<void> {
    const player = this.player;
    const generation = this.generation;
    if (!player?.process?.pid) return;
    let imported: Electron.SharedTextureImported | undefined;
    try {
      imported = this.handles.import(player.process.pid, frame.handle, (ntHandle) =>
        sharedTexture.importSharedTexture({
          textureInfo: {
            pixelFormat: "rgba",
            codedSize: { width: frame.width, height: frame.height },
            colorSpace: { primaries: "bt709", transfer: "srgb", matrix: "rgb", range: "full" },
            handle: { ntHandle },
          },
          allReferencesReleased: () => {
            if (this.player === player && this.generation === generation)
              player.frames?.release(frame.sequence);
          },
        }),
      );
      await sharedTexture.sendSharedTexture(
        {
          frame: this.contents.mainFrame,
          importedSharedTexture: imported,
        },
        generation,
      );
    } catch (cause) {
      if (this.player === player)
        this.fail(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      imported?.release();
    }
  }

  show(): Promise<void> {
    return this.presentation;
  }

  hide(): void {
    clearTimeout(this.timer);
    this.rejectPresentation?.(new Error("Video presentation cancelled"));
    this.rejectPresentation = null;
    this.presented = null;
    this.player?.frames?.dispose();
    this.player = null;
    this.failure = null;
    this.generation++;
    if (!this.contents.isDestroyed()) this.contents.send("video:generation", this.generation);
  }

  private fail(error: Error): void {
    const failure = this.failure;
    const player = this.player;
    this.rejectPresentation?.(error);
    this.hide();
    failure?.(error);
    void player?.stop();
  }

  dispose(): void {
    this.lost();
    ipcMain.off("video:status", this.status);
    app.off("child-process-gone", this.childGone);
    this.window.off("move", this.resize);
    this.contents.off("zoom-changed", this.resize);
    this.contents.off("render-process-gone", this.lost);
    this.contents.off("did-start-loading", this.lost);
    this.contents.off("destroyed", this.lost);
  }
}
