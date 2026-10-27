import { BrowserWindow, type Rectangle } from "electron";
import { mainWindowDefaultSize, mainWindowMinimumSize } from "./MainWindowState";

export interface DesktopWindowOptions {
  readonly url?: string;
  readonly parent?: BrowserWindow;
  readonly preloadPath?: string;
  readonly bounds?: Rectangle;
  readonly maximized?: boolean;
}

export const createMainWindow = (options: DesktopWindowOptions = {}): Electron.BrowserWindow => {
  const window = new BrowserWindow({
    ...(options.bounds ?? mainWindowDefaultSize),
    minWidth: mainWindowMinimumSize.width,
    minHeight: mainWindowMinimumSize.height,
    backgroundColor: "#0c0c0e",
    show: false,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      ...(options.preloadPath === undefined ? {} : { preload: options.preloadPath }),
    },
  });
  if (process.platform === "win32") window.removeMenu();
  window.once("ready-to-show", () => {
    // Maximizing also shows the window, so it waits for the first paint like show() does.
    if (options.maximized === true) window.maximize();
    window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  if (options.url !== undefined) void window.loadURL(options.url);
  return window;
};
