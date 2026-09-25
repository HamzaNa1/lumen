import { BrowserWindow } from "electron";

export interface DesktopWindowOptions {
  readonly url?: string;
  readonly parent?: BrowserWindow;
  readonly preloadPath?: string;
}

export const createMainWindow = (options: DesktopWindowOptions = {}): Electron.BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0c0c0e",
    show: false,
    parent: options.parent,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: options.preloadPath,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  if (options.url !== undefined) void window.loadURL(options.url);
  return window;
};
