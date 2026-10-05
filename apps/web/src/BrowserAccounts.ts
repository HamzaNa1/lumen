import type { ServerApi, ServerIdentity } from "@lumen/client";
import type { AccountsRuntime } from "@lumen/client/runtime";
import type {
  AccountList,
  AccountSummary,
  BrowserSession,
  ConnectionInput,
  ServerDiscovery,
} from "@lumen/contracts";
import { deviceIdFor } from "./deviceId";
import { SessionChannel } from "./SessionChannel";

const DEVICE_NAME = "Lumen Web";

/**
 * The browser's one account: whoever is signed in to the server that served this page. The
 * session itself is a cookie this code cannot read; what it holds is the account the server
 * reports for that cookie.
 */
export class BrowserAccounts implements AccountsRuntime {
  readonly fixedOrigin: string;
  private readonly listeners = new Set<() => void>();
  private readonly channel: SessionChannel;
  private identity: ServerIdentity | null = null;
  private account: AccountSummary | null = null;
  /** Whether `account` reflects the server's current answer for the cookie. */
  private restored = false;
  private restoring: Promise<void> | null = null;
  private generation = 0;
  private authenticationGeneration: number | null = null;

  constructor(
    private readonly api: ServerApi,
    /** Stops everything that belongs to the account that is going away. */
    private readonly endAccountActivity: () => Promise<void>,
  ) {
    this.fixedOrigin = api.serverOrigin;
    this.channel = new SessionChannel((event) => {
      // Another tab changed the shared session: stop using it here and ask the server again.
      if (event === "signed-out") void this.forget();
      else {
        this.invalidatePending();
        this.restored = false;
        this.notify();
      }
    });
  }

  readonly list = async (): Promise<AccountList> => {
    if (!this.restored && this.authenticationGeneration === null) await this.restore();
    return this.snapshot();
  };

  readonly discoverServer = async (): Promise<ServerDiscovery> => {
    const discovery = await this.api.discover();
    this.identity = discovery.identity;
    return discovery;
  };

  readonly connect = (input: ConnectionInput): Promise<AccountList> =>
    this.changeAuthentication(async (generation) => {
      const discovery = await this.discoverServer();
      if (generation !== this.generation) return this.snapshot();
      const device = {
        deviceId: deviceIdFor(discovery.identity.serverId, input.username),
        deviceName: DEVICE_NAME,
        platform: "web" as const,
      };
      const session = await (discovery.setupRequired || input.signUp === true
        ? this.api.browserRegister(input, device)
        : this.api.browserLogin(input, device));
      if (generation !== this.generation) return this.snapshot();
      await this.replace(session, generation);
      if (generation !== this.generation) return this.snapshot();
      this.channel.announce("signed-in");
      return this.snapshot();
    });

  readonly activate = async (): Promise<AccountList> => {
    if (this.authenticationGeneration !== null) return this.snapshot();
    this.invalidatePending();
    this.restored = false;
    await this.restore();
    if (this.account === null) throw new Error("Sign-in required");
    return this.snapshot();
  };

  readonly remove = (): Promise<AccountList> =>
    this.changeAuthentication(async (generation) => {
      // Playback is stopped first, while the session can still save where the viewer was.
      await this.endAccountActivity();
      if (generation !== this.generation) return this.snapshot();
      // If the server cannot be told, the cookie is still valid, so this stays signed in and the
      // failure is reported rather than pretending the session is gone.
      await this.api.browserLogout();
      if (generation !== this.generation) return this.snapshot();
      this.account = null;
      this.restored = true;
      this.api.cancelPending();
      this.channel.announce("signed-out");
      return this.snapshot();
    });

  readonly onChange = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };

  /** The server rejected the session: it expired or was revoked. */
  readonly sessionRejected = (): void => {
    if (this.account !== null) this.channel.announce("signed-out");
    void this.forget();
  };

  /** Confirms the session is still good, for when the page returns from being suspended. */
  async revalidate(): Promise<void> {
    if (this.account === null || this.authenticationGeneration !== null) return;
    const generation = this.invalidatePending();
    const session = await this.api.browserSession().catch(() => undefined);
    if (generation !== this.generation) return;
    // Undefined means the server could not be asked; only a definite "no session" signs out.
    if (session === null) this.sessionRejected();
    else if (session !== undefined && session.user.id !== this.account.userId) {
      await this.replace(session, generation);
      if (generation === this.generation) this.notify();
    }
  }

  dispose(): void {
    this.invalidatePending();
    this.channel.close();
    this.listeners.clear();
  }

  private restore(): Promise<void> {
    if (this.restoring !== null) return this.restoring;
    const generation = this.generation;
    const restoring = (async () => {
      const identity = this.identity ?? (await this.api.identity());
      if (generation !== this.generation) return;
      this.identity = identity;
      const session = await this.api.browserSession();
      if (generation !== this.generation) return;
      if (session === null) this.account = null;
      else await this.replace(session, generation);
      if (generation === this.generation) this.restored = true;
    })()
      .catch((cause: unknown) => {
        if (generation === this.generation) throw cause;
      })
      .finally(() => {
        if (this.restoring === restoring) this.restoring = null;
      });
    this.restoring = restoring;
    return restoring;
  }

  /**
   * Takes on the account the cookie now belongs to. When that is a different person, as after
   * another tab signed out and someone else signed in, everything the previous account had
   * running is ended first so none of it continues under the new one.
   */
  private async replace(session: BrowserSession, generation: number): Promise<void> {
    if (this.account !== null && this.account.userId !== session.user.id) {
      this.api.cancelPending();
      await this.endAccountActivity().catch(() => undefined);
    }
    if (generation === this.generation) this.adopt(session);
  }

  private adopt(session: BrowserSession): void {
    const identity = this.identity;
    if (identity === null) throw new Error("Connect to the server first");
    this.account = {
      connectionId: `web:${session.user.id}`,
      serverId: identity.serverId,
      serverLabel: identity.displayName,
      origin: this.api.serverOrigin,
      username: session.user.username,
      userId: session.user.id,
      role: session.user.role,
      // The browser, not this app, stores the sign-in.
      secureStorageAvailable: true,
      lastConnectedAtMs: null,
    };
    this.restored = true;
  }

  private async forget(): Promise<void> {
    const alreadyForgotten = this.account === null && this.restored;
    this.invalidatePending();
    this.account = null;
    this.restored = true;
    if (alreadyForgotten) return;
    this.api.cancelPending();
    this.notify();
    await this.endAccountActivity().catch(() => undefined);
  }

  private invalidatePending(): number {
    this.restoring = null;
    return ++this.generation;
  }

  private async changeAuthentication(
    operation: (generation: number) => Promise<AccountList>,
  ): Promise<AccountList> {
    const generation = this.invalidatePending();
    this.authenticationGeneration = generation;
    try {
      return await operation(generation);
    } finally {
      if (this.authenticationGeneration === generation) {
        this.invalidatePending();
        this.authenticationGeneration = null;
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private snapshot(): AccountList {
    return {
      accounts: this.account === null ? [] : [this.account],
      activeConnectionId: this.account?.connectionId ?? null,
    };
  }
}
