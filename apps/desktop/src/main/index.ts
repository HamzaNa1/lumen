import { join } from "node:path";
import { app, type BrowserWindow, nativeTheme } from "electron";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { AudioSettingsStore } from "./player/AudioSettingsStore";
import { PlayerController, startNativePlayer } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { broadcastPlayerFullscreen } from "./player/PlayerWindowState";
import { AppUpdates, supportsAutoUpdates } from "./updates/AppUpdates";
import { createMainWindow } from "./windows";

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
  // The interface is dark-only; keep native chrome (title bar, menus) consistent with it.
  nativeTheme.themeSource = "dark";
  const registry = await AccountRegistry.open();
  const installationId = await getOrCreateInstallationId(
    join(app.getPath("userData"), "installation.json"),
  );
  const audioSettings = await AudioSettingsStore.open(
    join(app.getPath("userData"), "audio-settings.json"),
  );
  bridge = new PlaybackBridge();
  await bridge.listen();
  mainWindow = createMainWindow({ preloadPath });
  const overlay = new PlayerOverlayWindow(mainWindow, preloadPath);
  player = new PlayerController({
    bridge,
    surface: new MpvSurface(mainWindow, overlay),
    audioSettings,
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
  const updates = new AppUpdates((version) => {
    mainWindow?.webContents.send("updates:ready", version);
  });
  registerIpcHandlers({
    registry,
    clients,
    player,
    bridge,
    installationId,
    window: mainWindow,
    overlay,
    updates,
  });
  broadcastPlayerFullscreen(mainWindow, overlay.window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(rendererPath);
  await overlay.load(rendererUrl, rendererPath);
  const stopUpdates = startNativePlayer(player);
  mainWindow.once("closed", stopUpdates);
  if (
    supportsAutoUpdates({
      platform: process.platform,
      isPackaged: app.isPackaged,
      portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    })
  ) {
    // Loaded only where it runs: reaching for the updater elsewhere sets up one that cannot work.
    const { autoUpdater } = await import("electron-updater");
    mainWindow.once("closed", updates.start(autoUpdater));
  }
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
