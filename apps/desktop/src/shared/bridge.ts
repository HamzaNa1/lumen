import type {
  AccountsRuntime,
  AdminRuntime,
  CatalogRuntime,
  PlayerAction,
  Unsubscribe,
  WatchRuntime,
} from "@lumen/client/runtime";
import type {
  AudioOutput,
  IpcPlayerSurfaceBounds,
  PlayerDisplay,
  PlayerState,
} from "@lumen/contracts";

/**
 * What the preload script exposes to the renderer as `window.lumen`. Catalog, administration and
 * watch groups have the shapes the shared application asks for; the player adds what only a native
 * window needs: where the video surface sits, and messages to and from the controls window.
 */
export interface DesktopBridge {
  readonly watch: WatchRuntime;
  readonly accounts: Pick<
    AccountsRuntime,
    "list" | "discoverServer" | "connect" | "activate" | "remove"
  >;
  readonly library: Omit<CatalogRuntime, "libraries"> & {
    readonly list: CatalogRuntime["libraries"];
    /** A data URL, since the renderer cannot authenticate to the server itself. */
    readonly artwork: (artworkId: string) => Promise<string | null>;
  };
  readonly admin: AdminRuntime;
  readonly player: {
    readonly start: (itemId: string, startAtSeconds?: number) => Promise<unknown>;
    readonly pause: (sessionId: string, paused: boolean) => Promise<PlayerState>;
    readonly seek: (sessionId: string, positionSeconds: number) => Promise<PlayerState>;
    readonly volume: (sessionId: string, volume: number, muted: boolean) => Promise<PlayerState>;
    readonly surface: (bounds: IpcPlayerSurfaceBounds | null) => Promise<unknown>;
    readonly selectAudio: (sessionId: string, streamId: string) => Promise<PlayerState>;
    readonly selectSubtitle: (sessionId: string, streamId: string | null) => Promise<PlayerState>;
    readonly audioOutput: (sessionId: string, output: AudioOutput) => Promise<PlayerState>;
    readonly copyAudioDiagnostics: (sessionId: string) => Promise<void>;
    readonly state: () => Promise<PlayerState | null>;
    readonly display: (display: PlayerDisplay) => Promise<void>;
    readonly displayState: () => Promise<PlayerDisplay | null>;
    readonly overlayAction: (action: PlayerAction) => Promise<void>;
    readonly fullscreen: (enabled: boolean) => Promise<boolean>;
    readonly fullscreenState: () => Promise<boolean>;
    readonly stop: () => Promise<unknown>;
    readonly onState: (callback: (state: PlayerState | null) => void) => Unsubscribe;
    readonly onDisplay: (callback: (display: PlayerDisplay) => void) => Unsubscribe;
    readonly onOverlayAction: (callback: (action: PlayerAction) => void) => Unsubscribe;
    readonly onFullscreenChange: (callback: (fullscreen: boolean) => void) => Unsubscribe;
  };
  readonly updates: {
    /** The downloaded version waiting to be installed, if any. */
    readonly ready: () => Promise<string | null>;
    readonly onReady: (callback: (version: string) => void) => Unsubscribe;
    /** Quits the app, installs the downloaded update and reopens it. */
    readonly install: () => Promise<void>;
  };
}

declare global {
  interface Window {
    readonly lumen: DesktopBridge;
  }
}
