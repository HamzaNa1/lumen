export type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

export const ipcHandlers = new Map<string, IpcHandler>();

// Bun fixes a mocked module's named exports when it is first loaded. All Electron tests
// share this shape so a later test can use IPC after a native-window test has loaded it.
export const electronTestExports = {
  BaseWindow: class {},
  BrowserWindow: class {},
  app: { getVersion: () => "test" },
  screen: {
    getDisplayMatching: (bounds: { x: number; y: number; width: number; height: number }) => ({
      bounds,
    }),
  },
  clipboard: {},
  ipcMain: {
    handle: (name: string, handler: IpcHandler) => ipcHandlers.set(name, handler),
    removeHandler: (name: string) => ipcHandlers.delete(name),
  },
};
