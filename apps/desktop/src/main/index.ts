import { join } from "node:path";
import { app, type BrowserWindow, nativeTheme } from "electron";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { createMainWindow } from "./windows";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;

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
  mainWindow.once("closed", () => {
    void player?.stop();
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
  setInterval(() => void player?.tick(), 3_000);
};

app.on("before-quit", () => {
  unregisterIpcHandlers();
  void player?.stop();
  void bridge?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) void bootstrap();
});

void bootstrap();
