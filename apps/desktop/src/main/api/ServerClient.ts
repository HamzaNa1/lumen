import type { IpcConnectionInput, IpcItemPage, IpcLibrary, IpcPlayerSession, IpcPlayerState } from "@lumen/contracts";
import { Effect, Schema } from "effect";

export interface ServerIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly apiVersion: string;
}

export interface AccountSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAtMs: number;
  readonly refreshExpiresAtMs: number;
}

export interface ServerClientOptions {
  readonly origin: string;
  readonly fetchImpl?: typeof fetch;
}

const identitySchema = Schema.Struct({
  serverId: Schema.String,
  displayName: Schema.String,
  apiVersion: Schema.String,
});

const sessionSchema = Schema.Struct({
  userId: Schema.String,
  sessionId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  accessExpiresAtMs: Schema.Number,
  refreshExpiresAtMs: Schema.Number,
});

const librarySchema = Schema.Array(Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: Schema.Literals(["movies", "shows", "music"]),
  isEnabled: Schema.Boolean,
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
}));

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
});

const normalizeOrigin = (value: string): string => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Unsupported server URL");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Server origin cannot contain a path");
  return url.origin;
};

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema)(value);

export class ServerClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private session: AccountSession | null = null;
  private refreshPromise: Promise<AccountSession> | null = null;

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

  setSession(session: AccountSession | null): void {
    this.session = session;
  }

  async identity(): Promise<ServerIdentity> {
    const response = await this.fetchImpl(new URL("/api/v1/server", this.origin), { redirect: "manual" });
    return decode(identitySchema, await readJson(response));
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
    const session = decode(sessionSchema, await readJson(response));
    this.session = session;
    return session;
  }

  async refresh(): Promise<AccountSession> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    if (this.session === null) throw new Error("No session");
    const current = this.session;
    this.refreshPromise = (async () => {
      const response = await this.fetchImpl(new URL("/api/v1/auth/refresh", this.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        redirect: "manual",
      });
      const session = decode(sessionSchema, await readJson(response));
      this.session = session;
      return session;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async request<T>(path: string, init: RequestInit = {}, schema?: Schema.Decoder<unknown, never>): Promise<T> {
    if (this.session === null) throw new Error("Authentication required");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.session.accessToken}`);
    let response = await this.fetchImpl(new URL(path, this.origin), { ...init, headers, redirect: "manual" });
    if (response.status === 401 && this.session.refreshToken !== "") {
      await this.refresh();
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("authorization", `Bearer ${this.session.accessToken}`);
      response = await this.fetchImpl(new URL(path, this.origin), { ...init, headers: retryHeaders, redirect: "manual" });
    }
    const value = await readJson(response);
    return schema === undefined ? (value as T) : decode(schema, value) as T;
  }

  async libraries(): Promise<ReadonlyArray<IpcLibrary>> {
    return this.request("/api/v1/libraries", {}, librarySchema);
  }

  async items(libraryId: string, cursor: string | null = null): Promise<IpcItemPage> {
    const query = new URLSearchParams({ libraryId, limit: "50" });
    if (cursor !== null) query.set("cursor", cursor);
    return this.request(`/api/v1/items?${query.toString()}`, {}, itemPageSchema);
  }

  async startPlayback(itemId: string, deviceId: string): Promise<IpcPlayerSession> {
    return this.request("/api/v1/playback/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, trackId: itemId }),
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
    throw new Error(message);
  }
  return response.json() as Promise<unknown>;
};

export const parseIdentity = (value: unknown): ServerIdentity => decode(identitySchema, value);
export const parseLibraries = (value: unknown): ReadonlyArray<IpcLibrary> => decode(librarySchema, value);
export const parsePlayerSession = (value: unknown): IpcPlayerSession => decode(playerSessionSchema, value);
export const parsePlayerState = (value: unknown): IpcPlayerState => decode(playerStateSchema, value);
export { decode as decodeIpc };
export const requestEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
