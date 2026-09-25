import { join } from "node:path";
import { app, powerMonitor, type BrowserWindow } from "electron";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { ShutdownCoordinator } from "./lifecycle/ShutdownCoordinator";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { ElectronUpdateAdapter } from "./updates/ElectronUpdateAdapter";
import { updateEligibility } from "./updates/UpdateEligibility";
import { UpdateService, type UpdateAdapter } from "./updates/UpdateService";
import { createMainWindow } from "./windows";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;
const closingPlayers = new Map<PlayerController, Promise<void>>();
let playerTickTimer: ReturnType<typeof setInterval> | null = null;
let updates: UpdateService | null = null;
let openPrimary: (() => Promise<void>) | null = null;

const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const rendererPath = join(import.meta.dirname, "../renderer/index.html");

if (process.platform === "linux") app.commandLine.appendSwitch("ozone-platform", "x11");

const shutdown = new ShutdownCoordinator({
  suspend: () => updates?.suspend(),
  cleanup: async () => {
    if (playerTickTimer !== null) clearInterval(playerTickTimer);
    playerTickTimer = null;
    unregisterIpcHandlers();
    await Promise.all(closingPlayers.values());
    await player?.stop();
    await bridge?.close();
  },
  fallback: () => {
    player?.forceStop();
    for (const controller of closingPlayers.keys()) controller.forceStop();
    bridge?.forceClose();
  },
  quit: () => app.quit(),
});

const bootstrap = async (): Promise<void> => {
  await app.whenReady();
  const registry = await AccountRegistry.open();
  const installationId = await getOrCreateInstallationId(
    join(app.getPath("userData"), "installation.json"),
  );
  const clients = new Map<string, ServerClient>();
  bridge = new PlaybackBridge();
  await bridge.listen();
  const playbackBridge = bridge;

  const eligibility = updateEligibility({
    packaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath,
    appImagePath: process.env.APPIMAGE,
    portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE,
  });
  const disabledAdapter: UpdateAdapter = {
    check: async () => null,
    onProgress: () => () => undefined,
    onError: () => () => undefined,
  };
  updates = new UpdateService({
    adapter: eligibility.eligible ? new ElectronUpdateAdapter() : disabledAdapter,
    currentVersion: app.getVersion(),
    eligible: eligibility.eligible,
    unsupportedReason: eligibility.reason,
  });
  const updateService = updates;
  updates.subscribe((state) => {
    if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("updates:state", state);
    }
  });

  const openWindow = async (): Promise<void> => {
    if (mainWindow !== null) { mainWindow.show(); mainWindow.focus(); return; }
    const window = createMainWindow({ preloadPath });
    mainWindow = window;
    const overlay = new PlayerOverlayWindow(window, preloadPath);
    const controller = new PlayerController({
      bridge: playbackBridge,
      surface: new MpvSurface(window, overlay),
      onState: (state) => {
        if (!window.webContents.isDestroyed()) window.webContents.send("player:state", state);
        if (!overlay.window.isDestroyed()) overlay.window.webContents.send("player:state", state);
      },
    });
    player = controller;
    registerIpcHandlers({
      registry, clients, player: controller, bridge: playbackBridge, installationId,
      window, overlay, updateState: () => updateService.snapshot(),
    });
    const sendFullscreenState = (): void => {
      if (!window.webContents.isDestroyed()) window.webContents.send("player:fullscreen-state", window.isFullScreen());
    };
    window.on("enter-full-screen", sendFullscreenState);
    window.on("leave-full-screen", sendFullscreenState);
    window.once("closed", () => {
      unregisterIpcHandlers();
      if (mainWindow === window) mainWindow = null;
      if (player === controller) player = null;
      const stopping = controller.stop();
      closingPlayers.set(controller, stopping);
      void stopping.then(
        () => { closingPlayers.delete(controller); },
        () => { /* Keep failed resources available to the shutdown fallback. */ },
      );
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl !== undefined) await window.loadURL(rendererUrl);
    else await window.loadFile(rendererPath);
    await overlay.load(rendererUrl, rendererPath);
    updates?.start();
  };

  openPrimary = openWindow;
  powerMonitor.on("resume", () => updates?.resume());
  playerTickTimer = setInterval(() => { void player?.tick(); }, 3_000);
  playerTickTimer.unref?.();
  await openWindow();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("activate", () => { void openPrimary?.(); });
  app.on("second-instance", () => { void openPrimary?.(); });
  app.on("before-quit", (event) => shutdown.beforeQuit(event));
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void bootstrap().catch((error: unknown) => {
    console.error("desktop startup failed", error);
    app.quit();
  });
}
