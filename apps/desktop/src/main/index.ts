import { join } from "node:path";
import { app, type BrowserWindow, nativeTheme, Notification } from "electron";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController, startNativePlayer } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { createMainWindow } from "./windows";
import { startWindowsAutoUpdates } from "./WindowsAutoUpdates";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;
let quitting = false;
let closingPlayback: Promise<void> | null = null;

const stopPlayerBeforeClose = (): Promise<void> => {
  if (closingPlayback !== null) return closingPlayback;
  const stopping = player?.stop().catch((cause: unknown) => {
    console.error("Failed to stop playback during app close", cause);
  });
  if (stopping === undefined) return Promise.resolve();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const waiting = Promise.race([
    stopping,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 1_000);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
    closingPlayback = null;
  });
  closingPlayback = waiting;
  return waiting;
};

const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const rendererPath = join(import.meta.dirname, "../renderer/index.html");

if (process.platform === "linux") app.commandLine.appendSwitch("ozone-platform", "x11");

const bootstrap = async (): Promise<void> => {
  await app.whenReady();
  if (process.platform === "win32") app.setAppUserModelId("dev.lumen.desktop");
  // The interface is dark-only; keep native chrome (title bar, menus) consistent with it.
  nativeTheme.themeSource = "dark";
  const registry = await AccountRegistry.open();
  const installationId = await getOrCreateInstallationId(
    join(app.getPath("userData"), "installation.json"),
  );
  bridge = new PlaybackBridge();
  await bridge.listen();
  mainWindow = createMainWindow({ preloadPath });
  const overlay = new PlayerOverlayWindow(mainWindow, preloadPath);
  player = new PlayerController({
    bridge,
    surface: new MpvSurface(mainWindow, overlay),
    onState: (state) => {
      mainWindow?.webContents.send("player:state", state);
      if (!overlay.window.isDestroyed()) overlay.window.webContents.send("player:state", state);
    },
  });
  let closingWindow = false;
  mainWindow.on("close", (event) => {
    if (closingWindow) {
      event.preventDefault();
      return;
    }
    if (player?.getState() == null) return;
    event.preventDefault();
    closingWindow = true;
    void stopPlayerBeforeClose().finally(() => mainWindow?.destroy());
  });
  mainWindow.once("closed", () => {
    void player?.stop().catch((cause: unknown) => console.error("Failed to stop playback", cause));
  });
  const clients = new Map<string, ServerClient>();
  registerIpcHandlers({
    registry,
    clients,
    player,
    bridge,
    installationId,
    window: mainWindow,
    overlay,
  });
  const sendFullscreenState = (): void => {
    mainWindow?.webContents.send("player:fullscreen-state", mainWindow.isFullScreen());
  };
  mainWindow.on("enter-full-screen", sendFullscreenState);
  mainWindow.on("leave-full-screen", sendFullscreenState);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(rendererPath);
  await overlay.load(rendererUrl, rendererPath);
  const stopUpdates = startNativePlayer(player);
  mainWindow.once("closed", stopUpdates);
  const stopAutoUpdates = await startWindowsAutoUpdates({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isPortable: process.env.PORTABLE_EXECUTABLE_DIR !== undefined,
    createUpdater: async () => {
      const { default: electronUpdater } = await import("electron-updater");
      return electronUpdater.autoUpdater;
    },
    notifyDownloaded: (version) => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: "Lumen update ready",
        body: `Version ${version} has been downloaded and will be installed when you close Lumen.`,
      }).show();
    },
  });
  if (mainWindow.isDestroyed()) stopAutoUpdates();
  else mainWindow.once("closed", stopAutoUpdates);
};

app.on("before-quit", (event) => {
  if (quitting && closingPlayback !== null) {
    event.preventDefault();
    return;
  }
  if (!quitting && (player?.getState() != null || closingPlayback !== null)) {
    event.preventDefault();
    quitting = true;
    void stopPlayerBeforeClose().finally(() => app.quit());
    return;
  }
  unregisterIpcHandlers();
  void player?.stop().catch((cause: unknown) => console.error("Failed to stop playback", cause));
  void bridge?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) void bootstrap();
});

void bootstrap();
