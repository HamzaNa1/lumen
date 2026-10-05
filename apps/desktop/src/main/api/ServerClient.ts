import {
  type AccountSession as TokenSession,
  bearerCredentials,
  type CredentialsInput,
  type DeviceDescription,
  type FetchLike,
  ServerApi,
  type WatchAuthentication,
  type WatchServer,
} from "@lumen/client";

export { ServerHttpError } from "@lumen/client";

export interface AccountSession extends TokenSession {
  readonly refreshToken?: string; // Read only while exchanging credentials saved by older versions.
}

export interface ServerClientOptions {
  readonly origin: string;
  readonly fetchImpl?: FetchLike;
}

const describeDevice = (deviceId: string): DeviceDescription => ({
  deviceId,
  deviceName: "Lumen Desktop",
  platform: "desktop",
});

/** The server API as the desktop uses it: one saved bearer-token session per connection. */
export class ServerClient extends ServerApi implements WatchServer {
  private readonly held: { session: AccountSession | null };

  constructor(options: ServerClientOptions) {
    const held: { session: AccountSession | null } = { session: null };
    super({ ...options, credentials: bearerCredentials(() => held.session?.accessToken ?? null) });
    this.held = held;
  }

  get accessToken(): string | null {
    return this.held.session?.accessToken ?? null;
  }

  get currentSession(): AccountSession | null {
    return this.held.session;
  }

  setSession(session: AccountSession | null): void {
    const previous = this.held.session;
    this.held.session = session;
    // Requests made for a different session must not answer the new one.
    if (previous !== null && previous.sessionId !== session?.sessionId) this.cancelPending();
  }

  watchAuthentication(): WatchAuthentication {
    return { token: this.accessToken ?? "" };
  }

  async register(input: CredentialsInput, deviceId: string): Promise<AccountSession> {
    return this.adopt(await this.tokenRegister(input, describeDevice(deviceId)));
  }

  async login(input: CredentialsInput, deviceId: string): Promise<AccountSession> {
    return this.adopt(await this.tokenLogin(input, describeDevice(deviceId)));
  }

  async migrateLegacySession(refreshToken: string): Promise<AccountSession> {
    return this.adopt(await this.migrateLegacyToken(refreshToken));
  }

  /** Artwork as a data URL, because the renderer cannot send this connection's token itself. */
  async artworkDataUrl(artworkId: string): Promise<string | null> {
    const image = await this.artworkImage(artworkId);
    if (image === null) return null;
    return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
  }

  private adopt(session: AccountSession): AccountSession {
    this.setSession(session);
    return session;
  }
}
