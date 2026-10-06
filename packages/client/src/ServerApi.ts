import {
  TrackPreferences,
  TrackMemory,
  type TrackPreferencesPatch,
  type TrackChoiceInput,
} from "@lumen/contracts";
import {
  BROWSER_CSRF_HEADER,
  BrowserSession,
  type CatalogItem,
  CatalogItemDetails,
  type CatalogItemPage,
  EpisodeOrderOptions,
  type EpisodeOrderSelection,
  HomeContent,
  JobLogEntry,
  type LibraryAccess,
  type LibrarySummary,
  ManagedUser,
  PlayableStream,
  type PlayerSession,
  type PlayerState,
  type ScanRun,
  type ServerDiscovery,
  ServerInfo,
  User,
  UserRole,
} from "@lumen/contracts";
import { Schema } from "effect";
import {
  AuthenticationRequiredError,
  assertCompatibleApi,
  parseRetryAfterSeconds,
  RequestCancelledError,
  ServerHttpError,
  ServerUnreachableError,
} from "./errors.ts";

export type ServerIdentity = ServerInfo;

/** A token session, as returned to clients that store and present the token themselves. */
export interface AccountSession {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
}

/**
 * How a request relates to the session: "none" sends no credentials, "credentials" attaches them,
 * and "session" also reports a rejected session to the owner of this client.
 */
type RequestAuth = "none" | "credentials" | "session";
export type { UserRole };
export type LibraryKind = LibrarySummary["kind"];
export type ScanMode = ScanRun["mode"];

/** How a platform proves who it is: a bearer token on desktop, the session cookie in a browser. */
export interface ApiCredentials {
  /** Adds credentials to an outgoing request. Throws when there is no session to send. */
  readonly authorize: (request: { readonly method: string; readonly headers: Headers }) => void;
  /** How the transport treats cookies. Left to the transport's default when omitted. */
  readonly cookies?: "include" | "omit" | "same-origin";
}

export const bearerCredentials = (accessToken: () => string | null): ApiCredentials => ({
  authorize: ({ headers }) => {
    const token = accessToken();
    if (token === null) throw new AuthenticationRequiredError();
    headers.set("authorization", `Bearer ${token}`);
  },
});

/** Same-origin cookie session. State-changing requests carry the header the server checks for CSRF. */
export const cookieCredentials = (): ApiCredentials => ({
  authorize: ({ method, headers }) => {
    if (method !== "GET" && method !== "HEAD") headers.set(BROWSER_CSRF_HEADER, "1");
  },
  cookies: "same-origin",
});

/** The transport: `fetch`, or a stand-in for it. */
export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface ServerApiOptions {
  readonly origin: string;
  readonly credentials: ApiCredentials;
  readonly fetchImpl?: FetchLike;
  /** Called when the server rejects this client's session. */
  readonly onUnauthorized?: () => void;
}

/** What the sign-in forms collect, wherever they are shown. */
export interface CredentialsInput {
  readonly username: string;
  readonly displayName?: string;
  readonly password: string;
}

/** How this client identifies itself to the server when it signs in. */
export interface DeviceDescription {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: "web" | "desktop";
}

export interface CreateUserInput {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly role?: UserRole;
  readonly libraryAccess?: LibraryAccess;
}

export interface UpdateUserInput {
  readonly displayName?: string;
  readonly password?: string;
  readonly role?: UserRole;
  readonly libraryAccess?: LibraryAccess;
  readonly isActive?: boolean;
}

export interface CreateLibraryInput {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: LibraryKind;
}

export interface UpdateLibraryInput {
  readonly name?: string;
  readonly slug?: string;
  readonly kind?: LibraryKind;
  readonly isEnabled?: boolean;
}

export interface AddLibraryRootInput {
  readonly id: string;
  readonly libraryId: string;
  readonly path: string;
  readonly priority: number;
}

export interface MetadataSettings {
  readonly tmdbConfigured: boolean;
}

export interface ArtworkImage {
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly bytes: Uint8Array;
}

const sessionSchema = Schema.Struct({
  userId: Schema.String,
  role: Schema.optional(UserRole),
  sessionId: Schema.String,
  accessToken: Schema.String,
  accessExpiresAtMs: Schema.Number,
});

const libraryEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: Schema.Literals(["movies", "shows", "music"]),
  isEnabled: Schema.Boolean,
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
});
const librarySchema = Schema.Array(libraryEntrySchema);

const scanRunSchema = Schema.Struct({
  id: Schema.String,
  libraryId: Schema.String,
  mode: Schema.Literals(["full", "incremental", "refresh"]),
  status: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
});

const itemPageSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      libraryId: Schema.String,
      title: Schema.String,
      kind: Schema.String,
      durationMs: Schema.NullOr(Schema.Number),
      year: Schema.NullOr(Schema.Number),
      artworkId: Schema.NullOr(Schema.String),
      completed: Schema.optional(Schema.Boolean),
      resumePositionSeconds: Schema.NullOr(Schema.Number),
      parentId: Schema.optional(Schema.NullOr(Schema.String)),
      indexNumber: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});

const playerSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  itemId: Schema.String,
  sourceId: Schema.String,
  title: Schema.String,
  streamUrl: Schema.String,
  durationSeconds: Schema.NullOr(Schema.Number),
  streams: Schema.Array(PlayableStream),
  grantExpiresInSeconds: Schema.Number,
  grantToken: Schema.String,
  trackMemory: Schema.optional(TrackMemory),
});

const serverNameSchema = Schema.Struct({ displayName: Schema.String.check(Schema.isMinLength(1)) });
const metadataSettingsSchema = Schema.Struct({ tmdbConfigured: Schema.Boolean });
const runSchema = Schema.Struct({ runId: Schema.String });

const ARTWORK_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_ARTWORK_BYTES = 20_000_000;
const JSON_HEADERS = { "content-type": "application/json" };

export const normalizeOrigin = (value: string): string => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported server URL");
  if (url.username !== "" || url.password !== "")
    throw new Error("URL credentials are not allowed");
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error("Server origin cannot contain a path");
  return url.origin;
};

export const decode = <S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value);

const decodeSession = (value: unknown): AccountSession => {
  const session = decode(sessionSchema, value);
  return { ...session, role: session.role ?? "user" };
};

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get("retry-after"),
      Date.now(),
    );
    let message = `Server request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {}
    throw new ServerHttpError(message, response.status, retryAfterSeconds);
  }
  return response.json() as Promise<unknown>;
};

const jsonBody = (method: string, value: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(value),
});

export const parseIdentity = (value: unknown): ServerIdentity => {
  const identity = decode(ServerInfo, value);
  assertCompatibleApi(identity.apiVersion);
  return identity;
};

/**
 * The server's HTTP API, independent of platform. Credentials and transport are injected, so the
 * same endpoint definitions serve the desktop's bearer tokens and the browser's cookie session.
 *
 * Requests are never retried here: callers decide which reads are safe to repeat, and a mutation
 * that failed in transit may already have taken effect.
 */
export class ServerApi {
  readonly serverOrigin: string;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: ApiCredentials;
  private readonly onUnauthorized: (() => void) | undefined;
  private serverIdentity: ServerIdentity | null = null;
  private scope = new AbortController();

  constructor(options: ServerApiOptions) {
    this.serverOrigin = normalizeOrigin(options.origin);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.credentials = options.credentials;
    this.onUnauthorized = options.onUnauthorized;
  }

  get supportsWatchGroups(): boolean {
    return this.serverIdentity?.capabilities?.watchGroups === true;
  }

  get supportsTrackMemory(): boolean {
    return this.serverIdentity?.capabilities?.trackMemory === true;
  }

  /**
   * Ends the current session's request scope: outstanding requests are aborted, and a response
   * that still arrives is rejected instead of reaching the next session's caches.
   */
  cancelPending(): void {
    const previous = this.scope;
    this.scope = new AbortController();
    previous.abort(new RequestCancelledError());
  }

  private async send(path: string, init: RequestInit, auth: RequestAuth): Promise<unknown> {
    const scope = this.scope;
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (auth !== "none") this.credentials.authorize({ method, headers });
    const signal =
      init.signal == null ? scope.signal : AbortSignal.any([scope.signal, init.signal]);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.serverOrigin), {
        ...init,
        headers,
        redirect: "manual",
        signal,
        ...(this.credentials.cookies === undefined
          ? {}
          : { credentials: this.credentials.cookies }),
      });
    } catch (cause) {
      if (scope.signal.aborted) throw new RequestCancelledError();
      if (init.signal?.aborted === true) throw cause;
      throw new ServerUnreachableError({ cause });
    }
    if (scope.signal.aborted) throw new RequestCancelledError();
    try {
      const value = await readJson(response);
      if (scope.signal.aborted) throw new RequestCancelledError();
      return value;
    } catch (cause) {
      if (scope.signal.aborted) throw new RequestCancelledError();
      if (auth === "session" && cause instanceof ServerHttpError && cause.status === 401)
        this.onUnauthorized?.();
      throw cause;
    }
  }

  /** An authenticated request. The response is validated when a schema is given. */
  async request<T>(
    path: string,
    init: RequestInit = {},
    schema?: Schema.Decoder<unknown, never>,
  ): Promise<T> {
    const value = await this.send(path, init, "session");
    return schema === undefined ? (value as T) : (decode(schema, value) as T);
  }

  // Discovery

  async identity(): Promise<ServerIdentity> {
    this.serverIdentity = parseIdentity(
      await this.send("/api/v1/server", { cache: "no-store" }, "none"),
    );
    return this.serverIdentity;
  }

  async setupRequired(fallback = false): Promise<boolean> {
    try {
      const value = await this.send("/api/v1/auth/setup", { cache: "no-store" }, "none");
      return decode(Schema.Struct({ setupRequired: Schema.Boolean }), value).setupRequired;
    } catch (cause) {
      if (cause instanceof ServerHttpError && cause.status === 404) return fallback;
      throw cause;
    }
  }

  async discover(): Promise<ServerDiscovery> {
    const identity = await this.identity();
    return {
      origin: this.serverOrigin,
      identity,
      setupRequired: await this.setupRequired(identity.setupRequired ?? false),
    };
  }

  // Token sessions: the caller stores the returned token and presents it as a bearer credential.

  async tokenRegister(input: CredentialsInput, device: DeviceDescription): Promise<AccountSession> {
    return decodeSession(
      await this.send(
        "/api/v1/auth/register",
        jsonBody("POST", {
          username: input.username,
          displayName: input.displayName ?? input.username,
          password: input.password,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          platformDeviceId: device.deviceId,
        }),
        "none",
      ),
    );
  }

  async tokenLogin(input: CredentialsInput, device: DeviceDescription): Promise<AccountSession> {
    return decodeSession(
      await this.send(
        "/api/v1/auth/login",
        jsonBody("POST", {
          username: input.username,
          password: input.password,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          platformDeviceId: device.deviceId,
        }),
        "none",
      ),
    );
  }

  async migrateLegacyToken(refreshToken: string): Promise<AccountSession> {
    return decodeSession(
      await this.send("/api/v1/auth/migrate-session", jsonBody("POST", { refreshToken }), "none"),
    );
  }

  // Browser sessions: the server keeps the token in an HttpOnly cookie and answers with the account.

  async browserRegister(
    input: CredentialsInput,
    device: DeviceDescription,
  ): Promise<BrowserSession> {
    return this.signIn(
      "/api/v1/auth/browser/register",
      jsonBody("POST", {
        username: input.username,
        displayName: input.displayName ?? input.username,
        password: input.password,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      }),
    );
  }

  async browserLogin(input: CredentialsInput, device: DeviceDescription): Promise<BrowserSession> {
    return this.signIn(
      "/api/v1/auth/browser/login",
      jsonBody("POST", {
        username: input.username,
        password: input.password,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      }),
    );
  }

  private async signIn(path: string, init: RequestInit): Promise<BrowserSession> {
    return decode(BrowserSession, await this.send(path, init, "credentials"));
  }

  /** The signed-in browser session, or null when there is none to restore. */
  async browserSession(): Promise<BrowserSession | null> {
    try {
      const value = await this.send("/api/v1/auth/browser/session", { cache: "no-store" }, "none");
      return decode(BrowserSession, value);
    } catch (cause) {
      if (cause instanceof ServerHttpError && cause.status === 401) return null;
      throw cause;
    }
  }

  async browserLogout(): Promise<void> {
    await this.request("/api/v1/auth/browser/logout", jsonBody("POST", {}));
  }

  async me(): Promise<User> {
    return this.request("/api/v1/auth/me", {}, User);
  }

  // Catalog

  async libraries(): Promise<ReadonlyArray<LibrarySummary>> {
    return this.request("/api/v1/libraries", {}, librarySchema);
  }

  async items(libraryId: string, cursor: string | null = null): Promise<CatalogItemPage> {
    const query = new URLSearchParams({ libraryId, limit: "50" });
    if (cursor !== null) query.set("cursor", cursor);
    return this.request(`/api/v1/items?${query.toString()}`, {}, itemPageSchema);
  }

  async home(): Promise<HomeContent> {
    return this.request("/api/v1/home", {}, HomeContent);
  }

  async itemDetails(itemId: string): Promise<CatalogItemDetails> {
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}`, {}, CatalogItemDetails);
  }

  async itemChildren(itemId: string, cursor: string | null = null): Promise<CatalogItemPage> {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    return this.request(
      `/api/v1/items/${encodeURIComponent(itemId)}/children?${query}`,
      {},
      itemPageSchema,
    );
  }

  async nextUp(itemId: string): Promise<CatalogItem | null> {
    const response = await this.request<{ item: CatalogItem | null }>(
      `/api/v1/items/${encodeURIComponent(itemId)}/next-up`,
    );
    return response.item;
  }

  async setWatched(itemId: string, completed: boolean): Promise<void> {
    await this.request(
      `/api/v1/items/${encodeURIComponent(itemId)}/watch-state`,
      jsonBody("PUT", { positionSeconds: 0, completed }),
    );
  }

  async search(query: string, libraryId: string | null = null): Promise<unknown> {
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (libraryId !== null) params.set("libraryId", libraryId);
    return this.request(`/api/v1/search?${params.toString()}`);
  }

  async episodeOrder(itemId: string): Promise<EpisodeOrderOptions> {
    return this.request(
      `/api/v1/items/${encodeURIComponent(itemId)}/episode-order`,
      {},
      EpisodeOrderOptions,
    );
  }

  async setEpisodeOrder(
    itemId: string,
    selection: EpisodeOrderSelection,
  ): Promise<{ readonly runId: string }> {
    return this.request(
      `/api/v1/items/${encodeURIComponent(itemId)}/episode-order`,
      jsonBody("PUT", selection),
      runSchema,
    );
  }

  artworkPath(artworkId: string): string {
    return `/api/v1/artwork/${encodeURIComponent(artworkId)}`;
  }

  /** The image itself, for platforms that cannot load artwork straight from the server. */
  async artworkImage(artworkId: string): Promise<ArtworkImage | null> {
    const headers = new Headers();
    this.credentials.authorize({ method: "GET", headers });
    const scope = this.scope;
    const response = await this.fetchImpl(new URL(this.artworkPath(artworkId), this.serverOrigin), {
      headers,
      redirect: "manual",
      signal: scope.signal,
      ...(this.credentials.cookies === undefined ? {} : { credentials: this.credentials.cookies }),
    });
    if (!response.ok) return null;
    const mimeType = ARTWORK_MIME_TYPES.find(
      (candidate) => candidate === response.headers.get("content-type")?.split(";")[0],
    );
    if (mimeType === undefined) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (scope.signal.aborted) throw new RequestCancelledError();
    return bytes.length > MAX_ARTWORK_BYTES ? null : { mimeType, bytes };
  }

  // Administration

  async adminLibraries(): Promise<ReadonlyArray<LibrarySummary>> {
    return this.request("/api/v1/admin/libraries", {}, librarySchema);
  }

  /** Renames the server for everyone who connects to it. */
  async renameServer(displayName: string): Promise<string> {
    const renamed = await this.request<{ readonly displayName: string }>(
      "/api/v1/admin/server",
      jsonBody("PUT", { displayName }),
      serverNameSchema,
    );
    if (this.serverIdentity !== null)
      this.serverIdentity = { ...this.serverIdentity, displayName: renamed.displayName };
    return renamed.displayName;
  }

  async metadataSettings(): Promise<MetadataSettings> {
    return this.request("/api/v1/admin/metadata-settings", {}, metadataSettingsSchema);
  }

  async updateMetadataSettings(tmdbApiKey: string | null): Promise<MetadataSettings> {
    return this.request(
      "/api/v1/admin/metadata-settings",
      jsonBody("PUT", { tmdbApiKey }),
      metadataSettingsSchema,
    );
  }

  async users(): Promise<ReadonlyArray<ManagedUser>> {
    return this.request("/api/v1/users", {}, Schema.Array(ManagedUser));
  }

  async createUser(input: CreateUserInput): Promise<ManagedUser> {
    return this.request("/api/v1/users", jsonBody("POST", input), ManagedUser);
  }

  async updateUser(userId: string, input: UpdateUserInput): Promise<ManagedUser> {
    return this.request(
      `/api/v1/users/${encodeURIComponent(userId)}`,
      jsonBody("PATCH", input),
      ManagedUser,
    );
  }

  async createLibrary(input: CreateLibraryInput): Promise<LibrarySummary> {
    return this.request("/api/v1/libraries", jsonBody("POST", input), libraryEntrySchema);
  }

  async updateLibrary(libraryId: string, input: UpdateLibraryInput): Promise<LibrarySummary> {
    return this.request(
      `/api/v1/libraries/${encodeURIComponent(libraryId)}`,
      jsonBody("PATCH", input),
      libraryEntrySchema,
    );
  }

  async deleteLibrary(libraryId: string): Promise<void> {
    await this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
  }

  async libraryRoots(libraryId: string): Promise<ReadonlyArray<unknown>> {
    return this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}/roots`);
  }

  async addLibraryRoot(input: AddLibraryRootInput): Promise<unknown> {
    return this.request(
      `/api/v1/libraries/${encodeURIComponent(input.libraryId)}/roots`,
      jsonBody("POST", input),
    );
  }

  async deleteLibraryRoot(rootId: string): Promise<void> {
    await this.request(`/api/v1/roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
  }

  async startScan(libraryId: string, mode: ScanMode): Promise<{ readonly runId: string }> {
    return this.request("/api/v1/scans", jsonBody("POST", { libraryId, mode }), runSchema);
  }

  async scanStatus(runId: string): Promise<ScanRun> {
    return this.request(`/api/v1/scans/${encodeURIComponent(runId)}`, {}, scanRunSchema);
  }

  async jobLog(limit = 100): Promise<ReadonlyArray<JobLogEntry>> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/api/v1/admin/jobs?${query}`, {}, Schema.Array(JobLogEntry));
  }

  async trackPreferences(): Promise<TrackPreferences | null> {
    if (!this.supportsTrackMemory) return null;
    return this.request("/api/v1/me/track-preferences", {}, TrackPreferences);
  }
  async updateTrackPreferences(input: TrackPreferencesPatch): Promise<TrackPreferences> {
    if (!this.supportsTrackMemory)
      throw new Error("This server does not support saved audio and subtitle settings.");
    return this.request("/api/v1/me/track-preferences", jsonBody("PATCH", input), TrackPreferences);
  }
  async saveTrackChoice(sessionId: string, input: TrackChoiceInput): Promise<TrackMemory | null> {
    if (!this.supportsTrackMemory) return null;
    return this.request(
      `/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/track-choice`,
      jsonBody("PUT", input),
      TrackMemory,
    );
  }

  // Playback sessions

  async startPlayback(itemId: string): Promise<PlayerSession> {
    return this.request(
      "/api/v1/playback/sessions",
      jsonBody("POST", { trackId: itemId }),
      playerSessionSchema,
    );
  }

  async heartbeat(sessionId: string, state: PlayerState): Promise<void> {
    await this.request(
      `/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
      jsonBody("POST", {
        state: state.ended ? "ended" : state.paused ? "paused" : "playing",
        activeTrackId: state.itemId,
        errorCode: null,
      }),
    );
  }

  async progress(
    sessionId: string,
    state: PlayerState,
    sequence: number,
    init: Pick<RequestInit, "keepalive"> = {},
  ): Promise<void> {
    await this.request(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/progress`, {
      ...jsonBody("POST", {
        trackId: state.itemId,
        positionMs: Math.round(state.positionSeconds * 1000),
        durationMs:
          state.durationSeconds === null ? null : Math.round(state.durationSeconds * 1000),
        sequence,
      }),
      ...init,
    });
  }

  async stopPlayback(sessionId: string, init: Pick<RequestInit, "keepalive"> = {}): Promise<void> {
    await this.request(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      ...init,
    });
  }
}
