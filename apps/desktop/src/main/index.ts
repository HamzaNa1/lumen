import { app, type BrowserWindow } from "electron";
import { join } from "node:path";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import type { ServerClient } from "./api/ServerClient";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { createMainWindow } from "./windows";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController } from "./player/PlayerController";
import { MpvSurface } from "./player/MpvSurface";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;

const bootstrap = async (): Promise<void> => {
  await app.whenReady();
  const registry = await AccountRegistry.open();
  const installationId = await getOrCreateInstallationId(
    join(app.getPath("userData"), "installation.json"),
  );
  bridge = new PlaybackBridge();
  await bridge.listen();
  const preloadPath = join(__dirname, "../preload/index.cjs");
  mainWindow = createMainWindow({ preloadPath });
  player = new PlayerController({
    bridge,
    surface: new MpvSurface(mainWindow),
    onState: (state) => {
      mainWindow?.webContents.send("player:state", state);
    },
  });
  const clients = new Map<string, ServerClient>();
  registerIpcHandlers({ registry, clients, player, bridge, installationId });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
