import type {
  AccountList,
  AdjacentEpisodes,
  AppUpdateStatus,
  ArtworkRef,
  AudioOutput,
  CatalogItem,
  CatalogItemDetails,
  CatalogItemPage,
  ConnectionInput,
  DirectoryListing,
  DownloadSettings,
  DownloadSettingsPatch,
  DownloadState,
  EpisodeOrderOptions,
  EpisodeOrderSelection,
  HomeContent,
  JobLogEntry,
  LibrarySummary,
  ManagedUser,
  MetadataMatchOptions,
  MetadataMatchSelection,
  PlaybackInfo,
  PlayerAction,
  PlayerDisplay,
  PlayerState,
  ScanRun,
  ServerDiscovery,
  TrackKind,
  TrackPreferences,
  TrackPreferencesPatch,
  TranscodingSettings,
  WatchAction,
  WatchStatus,
} from "@lumen/contracts";
import type {
  AddLibraryRootInput,
  CreateLibraryInput,
  CreateUserInput,
  MetadataSettings,
  ReplaceLibraryRootInput,
  ScanMode,
  UpdateLibraryInput,
  UpdateUserInput,
} from "./ServerApi.ts";

export type Unsubscribe = () => void;

/** What the platform can do. Shared pages offer only the actions these allow. */
export interface PlatformCapabilities {
  /** Servers and accounts can be added, switched and removed. */
  readonly serverSwitching: boolean;
  /** The player can choose how audio channels reach the output device. */
  readonly nativeAudioOutput: boolean;
  /** Audio and subtitle tracks inside a file can be switched during playback. */
  readonly trackSelection: boolean;
  readonly fullscreen: boolean;
}

export interface AccountsRuntime {
  readonly list: () => Promise<AccountList>;
  readonly discoverServer: (origin: string) => Promise<ServerDiscovery>;
  readonly connect: (input: ConnectionInput) => Promise<AccountList>;
  readonly activate: (connectionId: string) => Promise<AccountList>;
  /** Signs out and forgets the connection. */
  readonly remove: (connectionId: string) => Promise<AccountList>;
  /** Accounts changed outside this page: the session expired, or another window signed out. */
  readonly onChange: (callback: () => void) => Unsubscribe;
  /** The one server this platform talks to, when it cannot switch servers. */
  readonly fixedOrigin: string | null;
}

export interface CatalogRuntime {
  readonly home: () => Promise<HomeContent>;
  readonly libraries: () => Promise<ReadonlyArray<LibrarySummary>>;
  readonly items: (libraryId: string, cursor?: string | null) => Promise<CatalogItemPage>;
  readonly itemDetails: (itemId: string) => Promise<CatalogItemDetails>;
  readonly itemChildren: (itemId: string, cursor?: string | null) => Promise<CatalogItemPage>;
  readonly nextUp: (itemId: string) => Promise<CatalogItem | null>;
  readonly adjacentEpisodes: (itemId: string) => Promise<AdjacentEpisodes>;
  readonly setWatched: (itemId: string, completed: boolean) => Promise<void>;
  readonly search: (query: string, libraryId?: string | null) => Promise<unknown>;
  readonly episodeOrder: (itemId: string) => Promise<EpisodeOrderOptions>;
  readonly setEpisodeOrder: (
    itemId: string,
    selection: EpisodeOrderSelection,
  ) => Promise<{ readonly runId: string }>;
  /** TMDb titles this movie or show could be; a null query searches for its own title. */
  readonly matchOptions: (itemId: string, query: string | null) => Promise<MetadataMatchOptions>;
  readonly setMatch: (
    itemId: string,
    selection: MetadataMatchSelection,
  ) => Promise<{ readonly runId: string }>;
}

export interface ArtworkRuntime {
  /** Where an image element loads the artwork, scaled to one of `ARTWORK_WIDTHS` when it can be. */
  readonly url: (artwork: ArtworkRef, width: number) => string;
}

export interface AdminRuntime {
  readonly transcodingSettings: () => Promise<TranscodingSettings>;
  readonly updateTranscodingSettings: (
    settings: TranscodingSettings,
  ) => Promise<TranscodingSettings>;
  readonly listUsers: () => Promise<ReadonlyArray<ManagedUser>>;
  readonly createUser: (input: CreateUserInput) => Promise<ManagedUser>;
  readonly updateUser: (
    input: UpdateUserInput & { readonly userId: string },
  ) => Promise<ManagedUser>;
  readonly listLibraries: () => Promise<ReadonlyArray<LibrarySummary>>;
  /** Renames the server for everyone; the platform's accounts then carry the new name. */
  readonly renameServer: (name: string) => Promise<void>;
  readonly metadataSettings: () => Promise<MetadataSettings>;
  readonly updateMetadataSettings: (input: {
    readonly tmdbApiKey: string | null;
  }) => Promise<MetadataSettings>;
  readonly createLibrary: (input: CreateLibraryInput) => Promise<LibrarySummary>;
  readonly updateLibrary: (
    input: UpdateLibraryInput & { readonly libraryId: string },
  ) => Promise<LibrarySummary>;
  readonly deleteLibrary: (libraryId: string) => Promise<unknown>;
  readonly listRoots: (libraryId: string) => Promise<ReadonlyArray<unknown>>;
  readonly addRoot: (input: AddLibraryRootInput) => Promise<unknown>;
  /** Swaps a library's folder for another; the old folder's catalog entries are removed. */
  readonly replaceRoot: (input: ReplaceLibraryRootInput) => Promise<unknown>;
  readonly deleteRoot: (rootId: string) => Promise<unknown>;
  /** A folder on the server, or its home folder for null; null when the server cannot list folders. */
  readonly listDirectory: (path: string | null) => Promise<DirectoryListing | null>;
  readonly startScan: (input: {
    readonly libraryId: string;
    readonly mode: ScanMode;
  }) => Promise<{ readonly runId: string }>;
  readonly scanStatus: (runId: string) => Promise<ScanRun>;
  readonly jobLog: () => Promise<ReadonlyArray<JobLogEntry>>;
}

/**
 * Where the player controls are drawn. A browser draws them over its own video. The desktop's
 * native video covers the page, so its controls live in a separate window that is told what to
 * show and reports what the viewer pressed.
 */
export type PlayerPresentation =
  | { readonly kind: "inline" }
  | {
      readonly kind: "external";
      readonly display: (display: PlayerDisplay) => Promise<void>;
      readonly onAction: (callback: (action: PlayerAction) => void) => Unsubscribe;
    };

/** The place on the page where video appears, once the platform has claimed it. */
export interface PlayerSurface {
  /** Settles when the platform is ready to show video there. */
  readonly ready: Promise<void>;
  readonly release: () => void;
}

export interface NativeAudioRuntime {
  readonly output: (sessionId: string, output: AudioOutput) => Promise<PlayerState>;
}

export interface TrackSettingsRuntime {
  /** Null when the connected server does not advertise track memory support. */
  readonly read: () => Promise<TrackPreferences | null>;
  readonly update: (input: TrackPreferencesPatch) => Promise<TrackPreferences>;
}

export interface PlaybackRuntime {
  readonly resetTrack: (sessionId: string, kind: TrackKind) => Promise<PlayerState>;
  readonly retryTrackMemory: (sessionId: string) => Promise<PlayerState>;
  /** Gives up saving the track choices that failed to save, which clears the error. */
  readonly dismissTrackMemoryError: (sessionId: string) => Promise<PlayerState>;
  /**
   * Starts an item, or asks the watch group to when the viewer is in one. `replaces` is what the
   * viewer was watching when they asked; a group that has moved on from it plays nothing.
   */
  readonly start: (
    itemId: string,
    startAtSeconds?: number,
    title?: string,
    replaces?: string,
  ) => Promise<void>;
  readonly pause: (sessionId: string, paused: boolean) => Promise<PlayerState>;
  readonly seek: (sessionId: string, positionSeconds: number) => Promise<PlayerState>;
  readonly volume: (sessionId: string, volume: number, muted: boolean) => Promise<PlayerState>;
  readonly selectAudio: (sessionId: string, streamId: string) => Promise<PlayerState>;
  readonly selectSubtitle: (sessionId: string, streamId: string | null) => Promise<PlayerState>;
  /** What the player can tell about the playback in progress, for the viewer to troubleshoot it. */
  readonly info: (sessionId: string) => Promise<PlaybackInfo>;
  /**
   * Starts playback the platform held back until the viewer interacted. Only this viewer's
   * player changes; a watch group is not asked to do anything.
   */
  readonly allowPlayback: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly state: () => Promise<PlayerState | null>;
  readonly onState: (callback: (state: PlayerState | null) => void) => Unsubscribe;
  /** Playback failed after it had started. */
  readonly onFailure: (callback: (message: string) => void) => Unsubscribe;
  readonly mountSurface: (element: HTMLElement, onError: (cause: unknown) => void) => PlayerSurface;
  readonly fullscreen: (enabled: boolean) => Promise<boolean>;
  readonly fullscreenState: () => Promise<boolean>;
  readonly onFullscreenChange: (callback: (fullscreen: boolean) => void) => Unsubscribe;
  readonly presentation: PlayerPresentation;
  /** Present only where the player controls the audio device itself. */
  readonly nativeAudio: NativeAudioRuntime | null;
}

/** Media kept on this device to play later, and the streaming cache. */
export interface DownloadsRuntime {
  readonly state: () => Promise<DownloadState>;
  readonly onChange: (callback: () => void) => Unsubscribe;
  /** Downloads items of the active account, in order. */
  readonly add: (itemIds: ReadonlyArray<string>) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly pause: (id: string) => Promise<void>;
  /** Resumes a paused download, or retries a failed one. */
  readonly resume: (id: string) => Promise<void>;
  /** Exempts a download from automatic cleanup. */
  readonly keep: (id: string, keep: boolean) => Promise<void>;
  /** Removes the active account's downloads, or only the watched ones it is not keeping. */
  readonly removeAll: (watchedOnly: boolean) => Promise<void>;
  readonly clearCache: () => Promise<void>;
  readonly updateSettings: (patch: DownloadSettingsPatch) => Promise<DownloadSettings>;
  /** Keeps a show's next unwatched episodes downloaded; null stops doing so. */
  readonly showRule: (
    show: { readonly id: string; readonly title: string },
    episodes: number | null,
  ) => Promise<void>;
  /** The artwork kept with a download, as something an image element can load. */
  readonly artwork: (id: string) => Promise<string | null>;
}

/** New versions of the app itself. */
export interface AppUpdatesRuntime {
  readonly status: () => Promise<AppUpdateStatus>;
  readonly onChange: (callback: (status: AppUpdateStatus) => void) => Unsubscribe;
  /** Starts downloading the update, or opens its release page where the app cannot install it. */
  readonly download: () => Promise<void>;
  /** Quits, installs the downloaded update and reopens the app. */
  readonly install: () => Promise<void>;
  readonly setAutomatic: (automatic: boolean) => Promise<AppUpdateStatus>;
}

export interface WatchRuntime {
  readonly state: () => Promise<WatchStatus>;
  readonly action: (action: WatchAction) => Promise<WatchStatus>;
  readonly retry: () => Promise<void>;
  readonly onState: (callback: (status: WatchStatus) => void) => Unsubscribe;
}

/** Everything the shared application needs from the platform it runs on. */
export interface LumenRuntime {
  readonly capabilities: PlatformCapabilities;
  readonly trackSettings: TrackSettingsRuntime;
  readonly accounts: AccountsRuntime;
  readonly catalog: CatalogRuntime;
  readonly admin: AdminRuntime;
  readonly artwork: ArtworkRuntime;
  readonly playback: PlaybackRuntime;
  readonly watch: WatchRuntime;
  /** Null where media cannot be kept on the device. */
  readonly downloads: DownloadsRuntime | null;
  /** Null where the app is not installed, and a new version arrives with the page. */
  readonly appUpdates: AppUpdatesRuntime | null;
}
