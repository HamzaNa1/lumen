// Stands in for Electron's preload bridge so the desktop renderer build can run in a plain
// browser. It answers the renderer the way the desktop's main process does, through the same
// API client and watch-group client, but signs in with the test server's cookie session.
// Native playback is not reproduced: the page's address says what the player should report, so
// the controls can be drawn in a chosen state.
import { cookieCredentials, ServerApi, WatchGroupClient } from "../../packages/client/src/index.ts";
import type { PlayerDisplay, PlayerState, WatchStatus } from "../../packages/contracts/src/index.ts";
import type { DesktopBridge } from "../../apps/desktop/src/shared/bridge";

/** What the stand-in reports, given as JSON in the page's `scenario` query parameter. */
export interface ParityScenario {
  /** No saved account, as on first launch. */
  readonly signedOut?: boolean;
  /** What the main window told the controls window is playing. */
  readonly display?: PlayerDisplay;
  readonly player?: PlayerState;
}

const scenario = JSON.parse(
  new URLSearchParams(window.location.search).get("scenario") ?? "{}",
) as ParityScenario;

const api = new ServerApi({ origin: window.location.origin, credentials: cookieCredentials() });
const unavailable = async (): Promise<never> => {
  throw new Error("Not available in the parity harness");
};
const silent = () => () => undefined;

const watchListeners = new Set<(status: WatchStatus) => void>();
const watchClient = new WatchGroupClient(
  { serverOrigin: api.serverOrigin, watchAuthentication: () => ({ session: "cookie" }) },
  (status) => {
    for (const listener of watchListeners) listener(status);
  },
);

const accounts = async () => {
  const [identity, session] = await Promise.all([api.identity(), api.browserSession()]);
  if (session === null || scenario.signedOut === true)
    return { accounts: [], activeConnectionId: null };
  // The same account the web app derives from this session, so both apps label it alike.
  const connectionId = `web:${session.user.id}`;
  return {
    accounts: [
      {
        connectionId,
        serverId: identity.serverId,
        serverName: identity.displayName,
        // The baseline renderer reads the name from where the device's own label used to be.
        serverLabel: identity.displayName,
        origin: api.serverOrigin,
        username: session.user.username,
        userId: session.user.id,
        role: session.user.role,
        secureStorageAvailable: true,
        lastConnectedAtMs: null,
      },
    ],
    activeConnectionId: connectionId,
  };
};

const bridge: DesktopBridge = {
  trackSettings: { read: () => api.trackPreferences(), update: (input) => api.updateTrackPreferences(input) },
  watch: {
    state: async () => {
      watchClient.connect();
      return watchClient.status;
    },
    action: async (action) => {
      await watchClient.action(action);
      return watchClient.status;
    },
    retry: async () => undefined,
    onState: (callback) => {
      watchListeners.add(callback);
      return () => watchListeners.delete(callback);
    },
  },
  accounts: {
    list: accounts,
    discoverServer: () => api.discover(),
    connect: unavailable,
    activate: accounts,
    remove: unavailable,
  },
  library: {
    home: () => api.home(),
    list: () => api.libraries(),
    items: (libraryId, cursor) => api.items(libraryId, cursor),
    itemDetails: (itemId) => api.itemDetails(itemId),
    itemChildren: (itemId, cursor) => api.itemChildren(itemId, cursor),
    nextUp: (itemId) => api.nextUp(itemId),
    adjacentEpisodes: (itemId) => api.adjacentEpisodes(itemId),
    setWatched: (itemId, completed) => api.setWatched(itemId, completed),
    search: (query, libraryId) => api.search(query, libraryId),
    episodeOrder: (itemId) => api.episodeOrder(itemId),
    setEpisodeOrder: (itemId, selection) => api.setEpisodeOrder(itemId, selection),
    matchOptions: (itemId, query) => api.matchOptions(itemId, query),
    setMatch: (itemId, selection) => api.setMatch(itemId, selection),
    artwork: async (artwork) => api.artworkPath(artwork),
  },
  admin: {
    listUsers: () => api.users(),
    createUser: (input) => api.createUser(input),
    updateUser: ({ userId, ...input }) => api.updateUser(userId, input),
    listLibraries: () => api.adminLibraries(),
    renameServer: async (name) => void (await api.renameServer(name)),
    metadataSettings: () => api.metadataSettings(),
    updateMetadataSettings: ({ tmdbApiKey }) => api.updateMetadataSettings(tmdbApiKey),
    createLibrary: (input) => api.createLibrary(input),
    updateLibrary: ({ libraryId, ...input }) => api.updateLibrary(libraryId, input),
    deleteLibrary: (libraryId) => api.deleteLibrary(libraryId),
    listRoots: (libraryId) => api.libraryRoots(libraryId),
    addRoot: (input) => api.addLibraryRoot(input),
    deleteRoot: (rootId) => api.deleteLibraryRoot(rootId),
    startScan: ({ libraryId, mode }) => api.startScan(libraryId, mode),
    scanStatus: (runId) => api.scanStatus(runId),
    jobLog: () => api.jobLog(),
  },
  player: {
    resetTrack: unavailable,
    retryTrackMemory: unavailable,
    start: unavailable,
    pause: unavailable,
    seek: unavailable,
    volume: unavailable,
    surface: async () => undefined,
    selectAudio: unavailable,
    selectSubtitle: unavailable,
    audioOutput: unavailable,
    copyAudioDiagnostics: unavailable,
    state: async () => scenario.player ?? null,
    display: async () => undefined,
    displayState: async () => scenario.display ?? null,
    overlayAction: async () => undefined,
    fullscreen: async () => false,
    fullscreenState: async () => false,
    stop: async () => undefined,
    onState: silent,
    onDisplay: silent,
    onOverlayAction: silent,
    onFullscreenChange: silent,
  },
  updates: {
    ready: async () => null,
    onReady: silent,
    install: unavailable,
  },
};

Object.defineProperty(window, "lumen", { value: bridge });
