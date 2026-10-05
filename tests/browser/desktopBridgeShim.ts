// Stands in for Electron's preload bridge so the desktop renderer build can run in a plain
// browser. It answers the renderer the way the desktop's main process does, through the same
// API client, but signs in with the test server's cookie session. Native playback and watch
// groups are not reproduced: the parity test compares pages, not the player.
import { cookieCredentials, ServerApi } from "../../packages/client/src/index.ts";
import { initialWatchStatus } from "../../packages/contracts/src/index.ts";
import type { DesktopBridge } from "../../apps/desktop/src/shared/bridge";

const api = new ServerApi({ origin: window.location.origin, credentials: cookieCredentials() });
const unavailable = async (): Promise<never> => {
  throw new Error("Not available in the parity harness");
};
const silent = () => () => undefined;

const accounts = async () => {
  const [identity, session] = await Promise.all([api.identity(), api.browserSession()]);
  if (session === null) return { accounts: [], activeConnectionId: null };
  // The same account the web app derives from this session, so both apps label it alike.
  const connectionId = `web:${session.user.id}`;
  return {
    accounts: [
      {
        connectionId,
        serverId: identity.serverId,
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
  watch: {
    state: async () => initialWatchStatus(),
    action: unavailable,
    retry: async () => undefined,
    onState: silent,
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
    setWatched: (itemId, completed) => api.setWatched(itemId, completed),
    search: (query, libraryId) => api.search(query, libraryId),
    episodeOrder: (itemId) => api.episodeOrder(itemId),
    setEpisodeOrder: (itemId, selection) => api.setEpisodeOrder(itemId, selection),
    artwork: async (artworkId) => api.artworkPath(artworkId),
  },
  admin: {
    listUsers: () => api.users(),
    createUser: (input) => api.createUser(input),
    updateUser: ({ userId, ...input }) => api.updateUser(userId, input),
    listLibraries: () => api.adminLibraries(),
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
    start: unavailable,
    pause: unavailable,
    seek: unavailable,
    volume: unavailable,
    surface: async () => undefined,
    selectAudio: unavailable,
    selectSubtitle: unavailable,
    audioOutput: unavailable,
    copyAudioDiagnostics: unavailable,
    state: async () => null,
    display: async () => undefined,
    displayState: async () => null,
    overlayAction: async () => undefined,
    fullscreen: async () => false,
    fullscreenState: async () => false,
    stop: async () => undefined,
    onState: silent,
    onDisplay: silent,
    onOverlayAction: silent,
    onFullscreenChange: silent,
  },
};

Object.defineProperty(window, "lumen", { value: bridge });
