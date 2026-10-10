import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/bridge";

// The main process validates every argument and shapes every result, so a channel's result is
// trusted to have the type the bridge declares for it.
const invoke = <T>(channel: string, ...args: ReadonlyArray<unknown>): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const subscribe =
  <T>(channel: string) =>
  (callback: (value: T) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };

const api: DesktopBridge = {
  trackSettings: {
    read: () => invoke("track-settings:read"),
    update: (input) => invoke("track-settings:update", input),
  },
  watch: {
    retry: () => invoke("watch:retry"),
    state: () => invoke("watch:state"),
    action: (action) => invoke("watch:action", action),
    onState: subscribe("watch:state"),
  },
  accounts: {
    list: () => invoke("accounts:list"),
    discoverServer: (origin) => invoke("accounts:discover-server", origin),
    connect: (input) => invoke("accounts:connect", input),
    activate: (connectionId) => invoke("accounts:activate", connectionId),
    remove: (connectionId) => invoke("accounts:remove", connectionId),
  },
  library: {
    home: () => invoke("library:home"),
    list: () => invoke("library:list"),
    items: (libraryId, cursor = null) => invoke("library:items", { libraryId, cursor }),
    itemDetails: (itemId) => invoke("library:item-details", itemId),
    episodeOrder: (itemId) => invoke("library:episode-order", itemId),
    setEpisodeOrder: (itemId, selection) =>
      invoke("library:set-episode-order", { itemId, selection }),
    matchOptions: (itemId, query) => invoke("library:match-options", { itemId, query }),
    setMatch: (itemId, selection) => invoke("library:set-match", { itemId, selection }),
    itemChildren: (itemId, cursor = null) => invoke("library:item-children", { itemId, cursor }),
    setWatched: (itemId, completed) => invoke("library:set-watched", { itemId, completed }),
    nextUp: (itemId) => invoke("library:next-up", itemId),
    adjacentEpisodes: (itemId) => invoke("library:adjacent-episodes", itemId),
    artwork: (artworkId) => invoke("library:artwork", artworkId),
    search: (query, libraryId = null) => invoke("library:search", { query, libraryId }),
  },
  admin: {
    listUsers: () => invoke("admin:listUsers"),
    createUser: (input) => invoke("admin:createUser", input),
    updateUser: (input) => invoke("admin:updateUser", input),
    listLibraries: () => invoke("admin:listLibraries"),
    renameServer: (name) => invoke("admin:renameServer", name),
    metadataSettings: () => invoke("admin:metadataSettings"),
    updateMetadataSettings: (input) => invoke("admin:updateMetadataSettings", input),
    createLibrary: (input) => invoke("admin:createLibrary", input),
    updateLibrary: (input) => invoke("admin:updateLibrary", input),
    deleteLibrary: (libraryId) => invoke("admin:deleteLibrary", libraryId),
    listRoots: (libraryId) => invoke("admin:listRoots", libraryId),
    addRoot: (input) => invoke("admin:addRoot", input),
    deleteRoot: (rootId) => invoke("admin:deleteRoot", rootId),
    startScan: (input) => invoke("admin:startScan", input),
    scanStatus: (runId) => invoke("admin:scanStatus", runId),
    jobLog: () => invoke("admin:jobLog"),
  },
  player: {
    resetTrack: (sessionId, kind) => invoke("player:reset-track", { sessionId, kind }),
    retryTrackMemory: (sessionId) => invoke("player:retry-track-memory", sessionId),
    start: (itemId, startAtSeconds, title, replaces) =>
      invoke("player:start", { itemId, startAtSeconds, title, replaces }),
    pause: (sessionId, paused) => invoke("player:pause", { sessionId, paused }),
    seek: (sessionId, positionSeconds) => invoke("player:seek", { sessionId, positionSeconds }),
    volume: (sessionId, volume, muted) => invoke("player:volume", { sessionId, volume, muted }),
    surface: (bounds) => invoke("player:surface", bounds),
    selectAudio: (sessionId, streamId) => invoke("player:select-audio", { sessionId, streamId }),
    selectSubtitle: (sessionId, streamId) =>
      invoke("player:select-subtitle", { sessionId, streamId }),
    audioOutput: (sessionId, output) => invoke("player:audio-output", { sessionId, output }),
    copyAudioDiagnostics: (sessionId) => invoke("player:copy-audio-diagnostics", sessionId),
    state: () => invoke("player:state"),
    display: (display) => invoke("player:display", display),
    displayState: () => invoke("player:display-state"),
    overlayAction: (action) => invoke("player:overlay-action", action),
    fullscreen: (enabled) => invoke("player:fullscreen", enabled),
    fullscreenState: () => invoke("player:fullscreen-state"),
    stop: () => invoke("player:stop"),
    onState: subscribe("player:state"),
    onDisplay: subscribe("player:display"),
    onOverlayAction: subscribe("player:overlay-action"),
    onFullscreenChange: subscribe("player:fullscreen-state"),
  },
  updates: {
    ready: () => invoke("updates:ready"),
    onReady: subscribe("updates:ready"),
    install: () => invoke("updates:install"),
  },
};

contextBridge.exposeInMainWorld("lumen", api);
