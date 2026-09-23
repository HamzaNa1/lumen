import type { IpcAccounts, IpcItemPage, IpcLibrary, IpcPlayerState, IpcPlayerSession } from "@lumen/contracts";

export interface LumenBridge {
  readonly accounts: {
    readonly list: () => Promise<IpcAccounts>;
    readonly connect: (input: { readonly origin: string; readonly username: string; readonly password: string; readonly serverLabel: string }) => Promise<IpcAccounts>;
    readonly activate: (connectionId: string) => Promise<IpcAccounts>;
    readonly remove: (connectionId: string) => Promise<IpcAccounts>;
  };
  readonly library: {
    readonly list: () => Promise<ReadonlyArray<IpcLibrary>>;
    readonly items: (libraryId: string, cursor?: string | null) => Promise<IpcItemPage>;
    readonly search: (query: string, libraryId?: string | null) => Promise<unknown>;
  };
  readonly player: {
    readonly start: (itemId: string, deviceId: string) => Promise<Omit<IpcPlayerSession, "grantToken">>;
    readonly pause: (sessionId: string, paused: boolean) => Promise<IpcPlayerState>;
    readonly seek: (sessionId: string, positionSeconds: number) => Promise<IpcPlayerState>;
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

