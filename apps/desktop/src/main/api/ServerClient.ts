import { HomeContent, HomePreferences, IpcAudioOutput, IpcItemDetails, IpcPlayableStream, JobLogEntry } from "@lumen/contracts";
import type { IpcConnectionInput, IpcItem, IpcItemPage, IpcLibrary, IpcPlayerSession, IpcPlayerState, IpcServerDiscovery, ScanRun } from "@lumen/contracts";
import { User } from "../../../../../packages/contracts/src/schemas/auth";
import { Effect, Schema } from "effect";

export interface ServerIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly apiVersion: string;
  readonly setupRequired?: boolean;
}

export interface AccountSession {
  readonly userId: string;
  readonly role: "admin" | "user" | "guest";
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
  readonly refreshToken?: string; // Read only while exchanging credentials saved by older versions.
}

export interface ServerClientOptions {
  readonly origin: string;
  readonly fetchImpl?: typeof fetch;
}

export class ServerHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const identitySchema = Schema.Struct({
  serverId: Schema.String,
  displayName: Schema.String,
  apiVersion: Schema.String,
  setupRequired: Schema.optional(Schema.Boolean),
});

const sessionSchema = Schema.Struct({
  userId: Schema.String,
  role: Schema.optional(Schema.Literals(["admin", "user", "guest"])),
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
  items: Schema.Array(Schema.Struct({
    id: Schema.String,
    libraryId: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    durationMs: Schema.NullOr(Schema.Number),
    year: Schema.NullOr(Schema.Number),
    artworkId: Schema.NullOr(Schema.String),
    resumePositionSeconds: Schema.NullOr(Schema.Number),
    parentId: Schema.optional(Schema.NullOr(Schema.String)),
    indexNumber: Schema.optional(Schema.NullOr(Schema.Number)),
  })),
  nextCursor: Schema.NullOr(Schema.String),
});

const playerSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  itemId: Schema.String,
  sourceId: Schema.String,
  title: Schema.String,
  streamUrl: Schema.String,
  durationSeconds: Schema.NullOr(Schema.Number),
  streams: Schema.Array(IpcPlayableStream),
  grantExpiresInSeconds: Schema.Number,
  grantToken: Schema.String,
});

const playerStateSchema = Schema.Struct({
  sessionId: Schema.String,
  itemId: Schema.String,
  paused: Schema.Boolean,
  positionSeconds: Schema.Number,
  durationSeconds: Schema.NullOr(Schema.Number),
  volume: Schema.Number,
  muted: Schema.Boolean,
  ended: Schema.Boolean,
  streams: Schema.Array(IpcPlayableStream),
  selectedAudioStreamId: Schema.NullOr(Schema.String),
  selectedSubtitleStreamId: Schema.NullOr(Schema.String),
  audioOutput: IpcAudioOutput,
});

const normalizeOrigin = (value: string): string => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Unsupported server URL");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Server origin cannot contain a path");
  return url.origin;
};

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema)(value);
const decodeSession = (value: unknown): AccountSession => {
  const session = decode(sessionSchema, value);
  return { ...session, role: session.role ?? "user" };
};

export class ServerClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private session: AccountSession | null = null;

  constructor(options: ServerClientOptions) {
    this.origin = normalizeOrigin(options.origin);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get serverOrigin(): string {
    return this.origin;
  }

  get accessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  get currentSession(): AccountSession | null {
    return this.session;
  }

  setSession(session: AccountSession | null): void {
    this.session = session;
  }

  async identity(): Promise<ServerIdentity> {
    const response = await this.fetchImpl(new URL("/api/v1/server", this.origin), { redirect: "manual", cache: "no-store" });
    return decode(identitySchema, await readJson(response));
  }

  async setupRequired(fallback = false): Promise<boolean> {
    const response = await this.fetchImpl(new URL("/api/v1/auth/setup", this.origin), { redirect: "manual", cache: "no-store" });
    if (response.status === 404) return fallback;
    return decode(Schema.Struct({ setupRequired: Schema.Boolean }), await readJson(response)).setupRequired;
  }

  async discover(): Promise<IpcServerDiscovery> {
    const identity = await this.identity();
    return { origin: this.origin, identity, setupRequired: await this.setupRequired(identity.setupRequired ?? false) };
  }

  async me(): Promise<User> {
    return this.request("/api/v1/auth/me", {}, User);
  }

  async register(input: IpcConnectionInput, deviceId: string): Promise<AccountSession> {
    const response = await this.fetchImpl(new URL("/api/v1/auth/register", this.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        displayName: input.displayName ?? input.username,
        password: input.password,
        deviceId,
        deviceName: "Lumen Desktop",
        platform: "desktop",
        platformDeviceId: deviceId,
      }),
      redirect: "manual",
    });
    const session = decodeSession(await readJson(response));
    this.session = session;
    return session;
  }

  async login(input: IpcConnectionInput, deviceId: string): Promise<AccountSession> {
    const response = await this.fetchImpl(new URL("/api/v1/auth/login", this.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        deviceId,
        deviceName: "Lumen Desktop",
        platform: "desktop",
        platformDeviceId: deviceId,
      }),
      redirect: "manual",
    });
    const session = decodeSession(await readJson(response));
    this.session = session;
    return session;
  }

  async migrateLegacySession(refreshToken: string): Promise<AccountSession> {
    const response = await this.fetchImpl(new URL("/api/v1/auth/migrate-session", this.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      redirect: "manual",
    });
    const session = decodeSession(await readJson(response));
    this.session = session;
    return session;
  }

  async request<T>(path: string, init: RequestInit = {}, schema?: Schema.Decoder<unknown, never>): Promise<T> {
    if (this.session === null) throw new Error("Authentication required");
    const accessToken = this.session.accessToken;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    const response = await this.fetchImpl(new URL(path, this.origin), { ...init, headers, redirect: "manual" });
    const value = await readJson(response);
    return schema === undefined ? (value as T) : decode(schema, value) as T;
  }

  async libraries(): Promise<ReadonlyArray<IpcLibrary>> {
    return this.request("/api/v1/libraries", {}, librarySchema);
  }

  async adminLibraries(): Promise<ReadonlyArray<IpcLibrary>> {
    return this.request("/api/v1/admin/libraries", {}, librarySchema);
  }

  async metadataSettings(): Promise<{ readonly tmdbConfigured: boolean }> {
    return this.request("/api/v1/admin/metadata-settings", {}, Schema.Struct({ tmdbConfigured: Schema.Boolean }));
  }

  async updateMetadataSettings(tmdbApiKey: string | null): Promise<{ readonly tmdbConfigured: boolean }> {
    return this.request("/api/v1/admin/metadata-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tmdbApiKey }),
    }, Schema.Struct({ tmdbConfigured: Schema.Boolean }));
  }

  async users(): Promise<ReadonlyArray<User>> {
    return this.request("/api/v1/users", {}, Schema.Array(User));
  }

  async createUser(input: { readonly username: string; readonly displayName: string; readonly password: string; readonly role?: "admin" | "user" | "guest" }): Promise<User> {
    return this.request("/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, User);
  }

  async updateUser(userId: string, input: { readonly displayName?: string; readonly password?: string; readonly role?: "admin" | "user" | "guest"; readonly isActive?: boolean }): Promise<User> {
    return this.request(`/api/v1/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, User);
  }

  async createLibrary(input: { readonly id: string; readonly name: string; readonly slug: string; readonly kind: "movies" | "shows" | "music" }): Promise<IpcLibrary> {
    return this.request("/api/v1/libraries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, libraryEntrySchema);
  }

  async updateLibrary(libraryId: string, input: { readonly name?: string; readonly slug?: string; readonly kind?: "movies" | "shows" | "music"; readonly isEnabled?: boolean }): Promise<IpcLibrary> {
    return this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, libraryEntrySchema);
  }

  async deleteLibrary(libraryId: string): Promise<void> {
    await this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
  }

  async libraryRoots(libraryId: string): Promise<ReadonlyArray<unknown>> {
    return this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}/roots`);
  }

  async addLibraryRoot(input: { readonly id: string; readonly libraryId: string; readonly path: string; readonly priority: number }): Promise<unknown> {
    return this.request(`/api/v1/libraries/${encodeURIComponent(input.libraryId)}/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async deleteLibraryRoot(rootId: string): Promise<void> {
    await this.request(`/api/v1/roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
  }

  async startScan(libraryId: string, mode: "full" | "incremental" | "refresh"): Promise<{ readonly runId: string }> {
    return this.request("/api/v1/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ libraryId, mode }),
    }, Schema.Struct({ runId: Schema.String }));
  }

  async scanStatus(runId: string): Promise<ScanRun> {
    return this.request(`/api/v1/scans/${encodeURIComponent(runId)}`, {}, scanRunSchema);
  }

  async jobLog(limit = 100): Promise<ReadonlyArray<JobLogEntry>> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/api/v1/admin/jobs?${query}`, {}, Schema.Array(JobLogEntry));
  }

  async items(libraryId: string, cursor: string | null = null): Promise<IpcItemPage> {
    const query = new URLSearchParams({ libraryId, limit: "50" });
    if (cursor !== null) query.set("cursor", cursor);
    return this.request(`/api/v1/items?${query.toString()}`, {}, itemPageSchema);
  }

  async home(): Promise<HomeContent> {
    return this.request("/api/v1/home", {}, HomeContent);
  }

  async homePreferences(): Promise<HomePreferences> {
    return this.request("/api/v1/home/preferences", {}, HomePreferences);
  }

  async saveHomePreferences(preferences: HomePreferences): Promise<HomePreferences> {
    return this.request("/api/v1/home/preferences", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(decode(HomePreferences, preferences)),
    }, HomePreferences);
  }

  async itemDetails(itemId: string): Promise<IpcItemDetails> {
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}`, {}, IpcItemDetails);
  }

  async itemChildren(itemId: string, cursor: string | null = null): Promise<IpcItemPage> {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}/children?${query}`, {}, itemPageSchema);
  }

  async nextUp(itemId: string): Promise<IpcItem | null> {
    const response = await this.request<{ item: IpcItem | null }>(`/api/v1/items/${encodeURIComponent(itemId)}/next-up`);
    return response.item;
  }

  async artworkDataUrl(artworkId: string): Promise<string | null> {
    if (this.session === null) throw new Error("Authentication required");
    const accessToken = this.session.accessToken;
    const url = new URL(`/api/v1/artwork/${encodeURIComponent(artworkId)}`, this.origin);
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "manual" });
    if (!response.ok) return null;
    const mime = response.headers.get("content-type")?.split(";")[0];
    if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 20_000_000) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  }

  async startPlayback(itemId: string): Promise<IpcPlayerSession> {
    return this.request("/api/v1/playback/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: itemId }),
    }, playerSessionSchema);
  }

  async heartbeat(sessionId: string, state: IpcPlayerState): Promise<void> {
    await this.request(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: state.ended ? "ended" : state.paused ? "paused" : "playing", activeTrackId: state.itemId, errorCode: null }),
    });
  }

  async progress(sessionId: string, state: IpcPlayerState, sequence: number): Promise<void> {
    await this.request(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: state.itemId, positionMs: Math.round(state.positionSeconds * 1000), durationMs: state.durationSeconds === null ? null : Math.round(state.durationSeconds * 1000), sequence }),
    });
  }

  async search(query: string, libraryId: string | null = null): Promise<unknown> {
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (libraryId !== null) params.set("libraryId", libraryId);
    return this.request(`/api/v1/search?${params.toString()}`);
  }

  async playerState(value: unknown): Promise<IpcPlayerState> {
    return decode(playerStateSchema, value);
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    let message = `Server request failed (${response.status})`;
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {}
    throw new ServerHttpError(message, response.status);
  }
  return response.json() as Promise<unknown>;
};

export const parseIdentity = (value: unknown): ServerIdentity => decode(identitySchema, value);
export const parseLibraries = (value: unknown): ReadonlyArray<IpcLibrary> => decode(librarySchema, value);
export const parsePlayerSession = (value: unknown): IpcPlayerSession => decode(playerSessionSchema, value);
export const parsePlayerState = (value: unknown): IpcPlayerState => decode(playerStateSchema, value);
export { decode as decodeIpc };
export const requestEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
