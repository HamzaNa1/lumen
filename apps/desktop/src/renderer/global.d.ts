import type {
  EpisodeOrderOptions,
  WatchAction,
  WatchStatus,
  EpisodeOrderSelection,
  HomeContent,
  AccountList,
  CatalogItemPage,
  CatalogItem,
  CatalogItemDetails,
  LibrarySummary,
  PlayerDisplay,
  PlayerSession,
  PlayerState,
  IpcPlayerSurfaceBounds,
  ServerDiscovery,
  JobLogEntry,
  ScanRun,
  User,
} from "@lumen/contracts";

export interface LumenBridge {
  readonly watch: {
    readonly retry: () => Promise<void>;
    readonly state: () => Promise<WatchStatus>;
    readonly action: (action: WatchAction) => Promise<WatchStatus>;
    readonly onState: (callback: (status: WatchStatus) => void) => () => void;
  };
  readonly accounts: {
    readonly list: () => Promise<AccountList>;
    readonly discoverServer: (origin: string) => Promise<ServerDiscovery>;
    readonly connect: (input: {
      readonly origin: string;
      readonly username: string;
      readonly displayName?: string;
      readonly password: string;
      readonly serverLabel: string;
      readonly signUp?: boolean;
    }) => Promise<AccountList>;
    readonly setup: (origin: string) => Promise<boolean>;
    readonly activate: (connectionId: string) => Promise<AccountList>;
    readonly remove: (connectionId: string) => Promise<AccountList>;
  };
  readonly library: {
    readonly home: () => Promise<HomeContent>;
    readonly list: () => Promise<ReadonlyArray<LibrarySummary>>;
    readonly items: (libraryId: string, cursor?: string | null) => Promise<CatalogItemPage>;
    readonly itemDetails: (itemId: string) => Promise<CatalogItemDetails>;
    readonly episodeOrder: (itemId: string) => Promise<EpisodeOrderOptions>;
    readonly setEpisodeOrder: (
      itemId: string,
      selection: EpisodeOrderSelection,
    ) => Promise<{ readonly runId: string }>;
    readonly itemChildren: (itemId: string, cursor?: string | null) => Promise<CatalogItemPage>;
    readonly setWatched: (itemId: string, completed: boolean) => Promise<void>;
    readonly nextUp: (itemId: string) => Promise<CatalogItem | null>;
    readonly artwork: (artworkId: string) => Promise<string | null>;
    readonly search: (query: string, libraryId?: string | null) => Promise<unknown>;
  };
  readonly admin: {
    readonly listUsers: () => Promise<ReadonlyArray<User>>;
    readonly createUser: (input: {
      readonly username: string;
      readonly displayName: string;
      readonly password: string;
      readonly role?: "admin" | "user" | "guest";
    }) => Promise<User>;
    readonly updateUser: (input: {
      readonly userId: string;
      readonly displayName?: string;
      readonly password?: string;
      readonly role?: "admin" | "user" | "guest";
      readonly isActive?: boolean;
    }) => Promise<User>;
    readonly listLibraries: () => Promise<ReadonlyArray<LibrarySummary>>;
    readonly metadataSettings: () => Promise<{ readonly tmdbConfigured: boolean }>;
    readonly updateMetadataSettings: (input: {
      readonly tmdbApiKey: string | null;
    }) => Promise<{ readonly tmdbConfigured: boolean }>;
    readonly createLibrary: (input: {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly kind: "movies" | "shows" | "music";
    }) => Promise<LibrarySummary>;
    readonly updateLibrary: (input: {
      readonly libraryId: string;
      readonly name?: string;
      readonly slug?: string;
      readonly kind?: "movies" | "shows" | "music";
      readonly isEnabled?: boolean;
    }) => Promise<LibrarySummary>;
    readonly deleteLibrary: (libraryId: string) => Promise<unknown>;
    readonly listRoots: (libraryId: string) => Promise<ReadonlyArray<unknown>>;
    readonly addRoot: (input: {
      readonly id: string;
      readonly libraryId: string;
      readonly path: string;
      readonly priority: number;
    }) => Promise<unknown>;
    readonly deleteRoot: (rootId: string) => Promise<unknown>;
    readonly startScan: (input: {
      readonly libraryId: string;
      readonly mode: "full" | "incremental" | "refresh";
    }) => Promise<{ readonly runId: string }>;
    readonly scanStatus: (runId: string) => Promise<ScanRun>;
    readonly jobLog: () => Promise<ReadonlyArray<JobLogEntry>>;
  };
  readonly player: {
    readonly start: (
      itemId: string,
      startAtSeconds?: number,
    ) => Promise<Omit<PlayerSession, "grantToken"> | null>;
    readonly pause: (sessionId: string, paused: boolean) => Promise<PlayerState>;
    readonly seek: (sessionId: string, positionSeconds: number) => Promise<PlayerState>;
    readonly volume: (sessionId: string, volume: number, muted: boolean) => Promise<PlayerState>;
    readonly surface: (bounds: IpcPlayerSurfaceBounds | null) => Promise<unknown>;
    readonly selectAudio: (sessionId: string, streamId: string) => Promise<PlayerState>;
    readonly selectSubtitle: (
      sessionId: string,
      streamId: string | null,
    ) => Promise<PlayerState>;
    readonly audioOutput: (
      sessionId: string,
      output: "stereo" | "auto-safe",
    ) => Promise<PlayerState>;
    readonly copyAudioDiagnostics: (sessionId: string) => Promise<void>;
    readonly state: () => Promise<PlayerState | null>;
    readonly display: (display: PlayerDisplay) => Promise<void>;
    readonly displayState: () => Promise<PlayerDisplay | null>;
    readonly overlayAction: (action: "back" | "retry" | "stop") => Promise<void>;
    readonly fullscreen: (enabled: boolean) => Promise<boolean>;
    readonly fullscreenState: () => Promise<boolean>;
    readonly stop: () => Promise<unknown>;
    readonly onState: (callback: (state: PlayerState | null) => void) => () => void;
    readonly onDisplay: (callback: (display: PlayerDisplay) => void) => () => void;
    readonly onOverlayAction: (callback: (action: "back" | "retry" | "stop") => void) => () => void;
    readonly onFullscreenChange: (callback: (fullscreen: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    readonly lumen: LumenBridge;
  }
}
