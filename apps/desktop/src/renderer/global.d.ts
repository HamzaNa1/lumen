import type {
  IpcAccounts,
  IpcItemPage,
  IpcLibrary,
  IpcPlayerState,
  IpcPlayerSession,
  IpcServerDiscovery,
  ScanRun,
  User,
} from "@lumen/contracts";

export interface LumenBridge {
  readonly accounts: {
    readonly list: () => Promise<IpcAccounts>;
    readonly discoverServer: (origin: string) => Promise<IpcServerDiscovery>;
    readonly connect: (input: {
      readonly origin: string;
      readonly username: string;
      readonly displayName?: string;
      readonly password: string;
      readonly serverLabel: string;
    }) => Promise<IpcAccounts>;
    readonly setup: (origin: string) => Promise<boolean>;
    readonly activate: (connectionId: string) => Promise<IpcAccounts>;
    readonly remove: (connectionId: string) => Promise<IpcAccounts>;
  };
  readonly library: {
    readonly list: () => Promise<ReadonlyArray<IpcLibrary>>;
    readonly items: (libraryId: string, cursor?: string | null) => Promise<IpcItemPage>;
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
    readonly listLibraries: () => Promise<ReadonlyArray<IpcLibrary>>;
    readonly createLibrary: (input: {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly kind: "movies" | "shows" | "music";
    }) => Promise<IpcLibrary>;
    readonly updateLibrary: (input: {
      readonly libraryId: string;
      readonly name?: string;
      readonly slug?: string;
      readonly kind?: "movies" | "shows" | "music";
      readonly isEnabled?: boolean;
    }) => Promise<IpcLibrary>;
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
  };
  readonly player: {
    readonly start: (itemId: string) => Promise<Omit<IpcPlayerSession, "grantToken">>;
    readonly pause: (sessionId: string, paused: boolean) => Promise<IpcPlayerState>;
    readonly seek: (sessionId: string, positionSeconds: number) => Promise<IpcPlayerState>;
    readonly volume: (sessionId: string, volume: number, muted: boolean) => Promise<IpcPlayerState>;
    readonly surface: (
      bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      } | null,
    ) => Promise<unknown>;
    readonly selectAudio: (sessionId: string, streamId: string) => Promise<IpcPlayerState>;
    readonly selectSubtitle: (
      sessionId: string,
      streamId: string | null,
    ) => Promise<IpcPlayerState>;
    readonly state: () => Promise<IpcPlayerState | null>;
    readonly stop: () => Promise<unknown>;
    readonly onState: (callback: (state: IpcPlayerState) => void) => () => void;
  };
}

declare global {
  interface Window {
    readonly lumen: LumenBridge;
  }
}
