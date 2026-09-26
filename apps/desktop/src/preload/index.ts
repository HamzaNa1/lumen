import type { IpcPlayerDisplay, IpcPlayerSurfaceBounds } from "@lumen/contracts";
import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, ...args: ReadonlyArray<unknown>): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  accounts: {
    list: () => invoke<unknown>("accounts:list"),
    setup: (origin: string) => invoke<unknown>("accounts:setup", { origin }),
    discoverServer: (origin: string) => invoke<unknown>("accounts:discover-server", origin),
    connect: (input: unknown) => invoke<unknown>("accounts:connect", input),
    activate: (connectionId: string) => invoke<unknown>("accounts:activate", connectionId),
    remove: (connectionId: string) => invoke<unknown>("accounts:remove", connectionId),
  },
  library: {
    list: () => invoke<unknown>("library:list"),
    items: (libraryId: string, cursor: string | null = null) =>
      invoke<unknown>("library:items", { libraryId, cursor }),
    itemDetails: (itemId: string) => invoke<unknown>("library:item-details", itemId),
    itemChildren: (itemId: string, cursor: string | null = null) => invoke<unknown>("library:item-children", { itemId, cursor }),
    nextUp: (itemId: string) => invoke<unknown>("library:next-up", itemId),
    artwork: (artworkId: string) => invoke<unknown>("library:artwork", artworkId),
    search: (query: string, libraryId: string | null = null) =>
      invoke<unknown>("library:search", { query, libraryId }),
  },
  admin: {
    listUsers: () => invoke<unknown>("admin:listUsers"),
    createUser: (input: unknown) => invoke<unknown>("admin:createUser", input),
    updateUser: (input: unknown) => invoke<unknown>("admin:updateUser", input),
    listLibraries: () => invoke<unknown>("admin:listLibraries"),
    metadataSettings: () => invoke<unknown>("admin:metadataSettings"),
    updateMetadataSettings: (input: unknown) => invoke<unknown>("admin:updateMetadataSettings", input),
    createLibrary: (input: unknown) => invoke<unknown>("admin:createLibrary", input),
    updateLibrary: (input: unknown) => invoke<unknown>("admin:updateLibrary", input),
    deleteLibrary: (libraryId: string) => invoke<unknown>("admin:deleteLibrary", libraryId),
    listRoots: (libraryId: string) => invoke<unknown>("admin:listRoots", libraryId),
    addRoot: (input: unknown) => invoke<unknown>("admin:addRoot", input),
    deleteRoot: (rootId: string) => invoke<unknown>("admin:deleteRoot", rootId),
    startScan: (input: unknown) => invoke<unknown>("admin:startScan", input),
    scanStatus: (runId: string) => invoke<unknown>("admin:scanStatus", runId),
    jobLog: () => invoke<unknown>("admin:jobLog"),
  },
  player: {
    start: (itemId: string, startAtSeconds?: number) =>
      invoke<unknown>("player:start", { itemId, startAtSeconds }),
    pause: (sessionId: string, paused: boolean) =>
      invoke<unknown>("player:pause", { sessionId, paused }),
    seek: (sessionId: string, positionSeconds: number) =>
      invoke<unknown>("player:seek", { sessionId, positionSeconds }),
    volume: (sessionId: string, volume: number, muted: boolean) =>
      invoke<unknown>("player:volume", { sessionId, volume, muted }),
    surface: (bounds: IpcPlayerSurfaceBounds | null) => invoke<unknown>("player:surface", bounds),
    selectAudio: (sessionId: string, streamId: string) =>
      invoke<unknown>("player:select-audio", { sessionId, streamId }),
    selectSubtitle: (sessionId: string, streamId: string | null) =>
      invoke<unknown>("player:select-subtitle", { sessionId, streamId }),
    audioOutput: (sessionId: string, output: "stereo" | "auto-safe") =>
      invoke<unknown>("player:audio-output", { sessionId, output }),
    copyAudioDiagnostics: (sessionId: string) => invoke<void>("player:copy-audio-diagnostics", sessionId),
    state: () => invoke<unknown>("player:state"),
    display: (display: IpcPlayerDisplay) => invoke<unknown>("player:display", display),
    displayState: () => invoke<unknown>("player:display-state"),
    overlayAction: (action: "back" | "retry" | "stop") =>
      invoke<unknown>("player:overlay-action", action),
    fullscreen: (enabled: boolean) => invoke<unknown>("player:fullscreen", enabled),
    fullscreenState: () => invoke<unknown>("player:fullscreen-state"),
    stop: () => invoke<unknown>("player:stop"),
    onDisplay: (callback: (display: IpcPlayerDisplay) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, display: IpcPlayerDisplay): void =>
        callback(display);
      ipcRenderer.on("player:display", listener);
      return () => ipcRenderer.removeListener("player:display", listener);
    },
    onOverlayAction: (callback: (action: "back" | "retry" | "stop") => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        action: "back" | "retry" | "stop",
      ): void => callback(action);
      ipcRenderer.on("player:overlay-action", listener);
      return () => ipcRenderer.removeListener("player:overlay-action", listener);
    },
    onFullscreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void =>
        callback(fullscreen);
      ipcRenderer.on("player:fullscreen-state", listener);
      return () => ipcRenderer.removeListener("player:fullscreen-state", listener);
    },
    onState: (callback: (state: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => callback(state);
      ipcRenderer.on("player:state", listener);
      return () => ipcRenderer.removeListener("player:state", listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld("lumen", api);
