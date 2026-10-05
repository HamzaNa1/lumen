import type {
  AccountList,
  BrowserDelivery,
  AudioOutput,
  CatalogItem,
  CatalogItemDetails,
  CatalogItemPage,
  ConnectionInput,
  EpisodeOrderOptions,
  EpisodeOrderSelection,
  HomeContent,
  JobLogEntry,
  LibrarySummary,
  ManagedUser,
  PlayerDisplay,
  PlayerState,
  ScanRun,
  ServerDiscovery,
  WatchAction,
  WatchStatus,
} from "@lumen/contracts";
import type {
  AddLibraryRootInput,
  CreateLibraryInput,
  CreateUserInput,
  MetadataSettings,
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
  /** The player can describe its audio pipeline for troubleshooting. */
  readonly audioDiagnostics: boolean;
  /** Audio and subtitle tracks inside a file can be switched during playback. */
  readonly trackSelection: boolean;
  readonly fullscreen: boolean;
  /** The player as settings describe it. */
  readonly player: { readonly name: string; readonly description: string };
  /** Where the sign-in is kept: in storage this app manages, or in a cookie the browser manages. */
  readonly signInStorage: "device" | "cookie";
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
  readonly setWatched: (itemId: string, completed: boolean) => Promise<void>;
  readonly search: (query: string, libraryId?: string | null) => Promise<unknown>;
  readonly episodeOrder: (itemId: string) => Promise<EpisodeOrderOptions>;
  readonly setEpisodeOrder: (
    itemId: string,
    selection: EpisodeOrderSelection,
  ) => Promise<{ readonly runId: string }>;
}

export interface ArtworkRuntime {
  /** Something an image element can load, or null when the artwork is unavailable. */
  readonly url: (artworkId: string) => Promise<string | null>;
}

export interface AdminRuntime {
  readonly listUsers: () => Promise<ReadonlyArray<ManagedUser>>;
  readonly createUser: (input: CreateUserInput) => Promise<ManagedUser>;
  readonly updateUser: (
    input: UpdateUserInput & { readonly userId: string },
  ) => Promise<ManagedUser>;
  readonly listLibraries: () => Promise<ReadonlyArray<LibrarySummary>>;
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
  readonly deleteRoot: (rootId: string) => Promise<unknown>;
  readonly startScan: (input: {
    readonly libraryId: string;
    readonly mode: ScanMode;
  }) => Promise<{ readonly runId: string }>;
  readonly scanStatus: (runId: string) => Promise<ScanRun>;
  readonly jobLog: () => Promise<ReadonlyArray<JobLogEntry>>;
}

export type PlayerAction = "back" | "retry" | "stop";

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
  readonly copyDiagnostics: (sessionId: string) => Promise<void>;
}

export interface BrowserDeliveryStatus {
  readonly phase: "preparing" | "direct" | "managed";
  readonly message: string;
  readonly progress: number;
}

export interface BrowserDeliveryRuntime {
  readonly supported: boolean;
  readonly preference: () => BrowserDelivery;
  readonly setPreference: (preference: BrowserDelivery) => void;
  readonly status: () => BrowserDeliveryStatus | null;
  readonly onStatus: (callback: (status: BrowserDeliveryStatus | null) => void) => Unsubscribe;
}

export interface PlaybackRuntime {
  readonly browserDelivery?: BrowserDeliveryRuntime;
  /** Starts an item, or asks the watch group to when the viewer is in one. */
  readonly start: (itemId: string, startAtSeconds?: number, title?: string) => Promise<void>;
  readonly pause: (sessionId: string, paused: boolean) => Promise<PlayerState>;
  readonly seek: (sessionId: string, positionSeconds: number) => Promise<PlayerState>;
  readonly volume: (sessionId: string, volume: number, muted: boolean) => Promise<PlayerState>;
  readonly selectAudio: (sessionId: string, streamId: string) => Promise<PlayerState>;
  readonly selectSubtitle: (sessionId: string, streamId: string | null) => Promise<PlayerState>;
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
  readonly copyDiagnostics?: () => Promise<void>;
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
  readonly accounts: AccountsRuntime;
  readonly catalog: CatalogRuntime;
  readonly admin: AdminRuntime;
  readonly artwork: ArtworkRuntime;
  readonly playback: PlaybackRuntime;
  readonly watch: WatchRuntime;
}
