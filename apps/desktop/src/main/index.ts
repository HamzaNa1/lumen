import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  nativeTheme,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
} from "electron";
import { ARTWORK_SCHEME } from "../shared/artworkUrl";
import { composesVideo } from "../shared/videoCompositor";
import { AccountRegistry } from "./accounts/AccountRegistry";
import { getOrCreateInstallationId } from "./accounts/InstallationId";
import { createTokenVault } from "./accounts/TokenVault";
import type { ServerClient } from "./api/ServerClient";
import { ArtworkCache } from "./artwork/ArtworkCache";
import { DownloadManager } from "./downloads/DownloadManager";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc/registerHandlers";
import { openMainWindowState, placeMainWindow, rememberMainWindowState } from "./MainWindowState";
import { openMediaStore } from "./media-store/openMediaStore";
import { AudioSettingsStore } from "./player/AudioSettingsStore";
import { CompositorSurface } from "./player/CompositorSurface";
import { MpvSurface } from "./player/MpvSurface";
import { PlaybackBridge } from "./player/PlaybackBridge";
import { PlayerController, startNativePlayer } from "./player/PlayerController";
import { PlayerOverlayWindow } from "./player/PlayerOverlayWindow";
import { broadcastPlayerFullscreen } from "./player/PlayerWindowState";
import {
  AppUpdates,
  githubReleasePage,
  openUpdateSettings,
  supportsAutoUpdates,
  type UpdateChannel,
} from "./updates/AppUpdates";
import { createMainWindow } from "./windows";

let mainWindow: BrowserWindow | null = null;
let bridge: PlaybackBridge | null = null;
let player: PlayerController | null = null;
let surface: MpvSurface | CompositorSurface | null = null;
let downloads: DownloadManager | null = null;
let closingPlayback: Promise<void> | null = null;
let quitting: "no" | "shuttingDown" | "ready" = "no";

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

const releasesUrl = "https://github.com/HamzaNa1/lumen/releases";

const updateChannel = async (): Promise<UpdateChannel | null> => {
  if (
    supportsAutoUpdates({
      platform: process.platform,
      isPackaged: app.isPackaged,
      portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    })
  ) {
    // Loaded only where it runs: reaching for the updater elsewhere sets up one that cannot work.
    const { autoUpdater } = await import("electron-updater");
    return { kind: "installer", source: autoUpdater };
  }
  const releases = process.env.LUMEN_E2E_RELEASES_URL ?? (app.isPackaged ? releasesUrl : null);
  return releases === null
    ? null
    : { kind: "page", page: githubReleasePage(releases, (url) => shell.openExternal(url)) };
};

const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const rendererPath = join(import.meta.dirname, "../renderer/index.html");

if (process.platform === "linux") app.commandLine.appendSwitch("ozone-platform", "x11");
protocol.registerSchemesAsPrivileged([
  { scheme: ARTWORK_SCHEME, privileges: { standard: true, secure: true } },
]);

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
  const windowState = await openMainWindowState(
    join(app.getPath("userData"), "main-window-state.json"),
  );
  bridge = new PlaybackBridge();
  await bridge.listen();
  const store = await openMediaStore(join(app.getPath("userData"), "media"));
  const clients = new Map<string, ServerClient>();
  const artwork = new ArtworkCache((partition) => session.fromPartition(partition));
  protocol.handle(ARTWORK_SCHEME, (request) => {
    const connectionId = registry.active()?.connectionId;
    const client = connectionId === undefined ? undefined : clients.get(connectionId);
    return artwork.respond(
      request.url,
      connectionId === undefined || client === undefined ? null : { connectionId, client },
    );
  });
  mainWindow = createMainWindow({
    preloadPath,
    bounds: placeMainWindow(windowState.current, {
      primary: screen.getPrimaryDisplay().workArea,
      all: screen.getAllDisplays().map((display) => display.workArea),
    }),
    maximized: windowState.current.maximized,
  });
  rememberMainWindowState(mainWindow, windowState);
  const compositor = composesVideo(process.platform);
  const overlay = compositor ? undefined : new PlayerOverlayWindow(mainWindow, preloadPath);
  surface = compositor ? new CompositorSurface(mainWindow) : new MpvSurface(mainWindow, overlay);
  const playing = { current: null as PlayerController | null };
  downloads = await DownloadManager.open({
    directory: join(app.getPath("userData"), "downloads"),
    store,
    clientFor: (connectionId) => clients.get(connectionId) ?? null,
    artworkTransport: (connectionId) => artwork.transportFor(connectionId),
    nowPlaying: () => playing.current?.nowPlaying() ?? null,
    vault: await createTokenVault("download-grants.bin"),
  });
  const manager = downloads;
  // A download in progress keeps the computer from sleeping, as playback does the display.
  let suspensionBlocker: number | null = null;
  manager.on("change", () => {
    const active = manager.isDownloading;
    if (active && suspensionBlocker === null)
      suspensionBlocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!active && suspensionBlocker !== null) {
      powerSaveBlocker.stop(suspensionBlocker);
      suspensionBlocker = null;
    }
  });
  player = new PlayerController({
    bridge,
    surface,
    audioSettings,
    store,
    onProgress: ({ connectionId, state }) => manager.observePlayback(connectionId, state),
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("player:state", state);
      if (overlay && !overlay.window.isDestroyed())
        overlay.window.webContents.send("player:state", state);
    },
  });
  playing.current = player;
  player.on("failure", (message: string) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("player:failure", message);
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
  const updates = new AppUpdates({
    channel: await updateChannel(),
    currentVersion: app.getVersion(),
    settings: await openUpdateSettings(join(app.getPath("userData"), "update-settings.json")),
    onChange: (status) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("updates:changed", status);
    },
  });
  registerIpcHandlers({
    registry,
    clients,
    artwork,
    player,
    downloads,
    bridge,
    installationId,
    window: mainWindow,
    overlay,
    updates,
  });
  broadcastPlayerFullscreen(mainWindow, overlay?.window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(rendererPath);
  await overlay?.load(rendererUrl, rendererPath);
  const stopUpdates = startNativePlayer(player);
  mainWindow.once("closed", stopUpdates);
  mainWindow.once("closed", updates.start());
};

const shutDown = async (): Promise<void> => {
  if (player?.getState() != null || closingPlayback !== null) await stopPlayerBeforeClose();
  // Downloads record what they hold before the app goes, so nothing is fetched twice.
  await Promise.race([
    downloads?.close().catch((cause: unknown) => console.error("Failed to stop downloads", cause)),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  downloads = null;
};

app.on("before-quit", (event) => {
  if (quitting !== "ready") {
    event.preventDefault();
    if (quitting === "no") {
      quitting = "shuttingDown";
      void shutDown().finally(() => {
        quitting = "ready";
        // macOS ignores a quit requested while it is still handling the ⌘Q that fired this event.
        setImmediate(() => app.quit());
      });
    }
    return;
  }
  surface?.dispose();
  surface = null;
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
