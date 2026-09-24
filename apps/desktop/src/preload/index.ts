import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, ...args: ReadonlyArray<unknown>): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

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
    items: (libraryId: string, cursor: string | null = null) => invoke<unknown>("library:items", { libraryId, cursor }),
    search: (query: string, libraryId: string | null = null) => invoke<unknown>("library:search", { query, libraryId }),
  },
  admin: {
    listUsers: () => invoke<unknown>("admin:listUsers"),
    createUser: (input: unknown) => invoke<unknown>("admin:createUser", input),
    updateUser: (input: unknown) => invoke<unknown>("admin:updateUser", input),
    listLibraries: () => invoke<unknown>("admin:listLibraries"),
    createLibrary: (input: unknown) => invoke<unknown>("admin:createLibrary", input),
    updateLibrary: (input: unknown) => invoke<unknown>("admin:updateLibrary", input),
    deleteLibrary: (libraryId: string) => invoke<unknown>("admin:deleteLibrary", libraryId),
    listRoots: (libraryId: string) => invoke<unknown>("admin:listRoots", libraryId),
    addRoot: (input: unknown) => invoke<unknown>("admin:addRoot", input),
    deleteRoot: (rootId: string) => invoke<unknown>("admin:deleteRoot", rootId),
    startScan: (input: unknown) => invoke<unknown>("admin:startScan", input),
    scanStatus: (runId: string) => invoke<unknown>("admin:scanStatus", runId),
  },
  player: {
    start: (itemId: string) => invoke<unknown>("player:start", { itemId }),
    pause: (sessionId: string, paused: boolean) => invoke<unknown>("player:pause", { sessionId, paused }),
    seek: (sessionId: string, positionSeconds: number) => invoke<unknown>("player:seek", { sessionId, positionSeconds }),
    selectAudio: (sessionId: string, streamId: string) => invoke<unknown>("player:select-audio", { sessionId, streamId }),
    selectSubtitle: (sessionId: string, streamId: string | null) => invoke<unknown>("player:select-subtitle", { sessionId, streamId }),
    state: () => invoke<unknown>("player:state"),
    stop: () => invoke<unknown>("player:stop"),
    onState: (callback: (state: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => callback(state);
      ipcRenderer.on("player:state", listener);
      return () => ipcRenderer.removeListener("player:state", listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld("lumen", api);
