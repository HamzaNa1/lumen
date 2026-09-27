import { PlaybackCoordinator } from "./player/PlaybackCoordinator";
import { join } from "node:path";
import { app, type BrowserWindow, nativeTheme, powerMonitor } from "electron";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController, startNativePlayer } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { createMainWindow } from "./windows";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;
let coordinator: PlaybackCoordinator | null = null;
let quitting = false;
let closingPlayback: Promise<void> | null = null;

const stopPlayerBeforeClose = (): Promise<void> => {
  if (closingPlayback !== null) return closingPlayback;
  const stopping = coordinator?.cleanup().catch((cause: unknown) => {
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
  coordinator = new PlaybackCoordinator(player, (state) => {
    if (mainWindow !== null && !mainWindow.isDestroyed())
      mainWindow.webContents.send("watch-groups:state", state);
    if (!overlay.window.isDestroyed()) overlay.window.webContents.send("watch-groups:state", state);
  });
  player.on("error", (error: unknown) => coordinator?.localFailure(error));
  player.on("player-lost", () => coordinator?.playerLost());
  const resume = () => coordinator?.resume();
  powerMonitor.on("resume", resume);
  mainWindow.once("closed", () => powerMonitor.off("resume", resume));
  let closingWindow = false;
  mainWindow.on("close", (event) => {
    if (closingWindow) {
      event.preventDefault();
      return;
    }
    if (player?.getState() == null && coordinator?.getState() == null) return;
    event.preventDefault();
    closingWindow = true;
    void stopPlayerBeforeClose().finally(() => mainWindow?.destroy());
  });
  mainWindow.once("closed", () => {
    void coordinator
      ?.cleanup()
      .catch((cause: unknown) => console.error("Failed to stop playback", cause));
  });
  const clients = new Map<string, ServerClient>();
  registerIpcHandlers({
    registry,
    clients,
    player,
    coordinator,
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
  const stopUpdates = startNativePlayer(player, async () => {
    await coordinator?.tick();
  });
  mainWindow.once("closed", stopUpdates);
};

app.on("before-quit", (event) => {
  if (quitting && closingPlayback !== null) {
    event.preventDefault();
    return;
  }
  if (
    !quitting &&
    (player?.getState() != null || coordinator?.getState() != null || closingPlayback !== null)
  ) {
    event.preventDefault();
    quitting = true;
    void stopPlayerBeforeClose().finally(() => app.quit());
    return;
  }
  unregisterIpcHandlers();
  void coordinator
    ?.cleanup()
    .catch((cause: unknown) => console.error("Failed to stop playback", cause));
  void bridge?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) void bootstrap();
});

void bootstrap();
