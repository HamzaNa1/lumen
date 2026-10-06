import {
  API_VERSION,
  TrackPreferencesPatch,
  TrackChoiceInput,
  BrowserSession,
  EpisodeOrderOptions,
  EpisodeOrderSelection,
  HomeContent,
  ServerInfo,
  User,
} from "@lumen/contracts";
import { version as serverVersion } from "../../package.json";
import { Effect, Schema } from "effect";
import { badRequest, notFound, ServerError, unauthorized } from "../core/Errors";
import { createLogger, type Logger } from "../core/Logger";
import {
  isRoutineProbe,
  requestIdFor,
  requestMethod,
  requestRoute,
  requestRange,
} from "./RequestLogging";
import { clientKey, type RequestContext } from "./ClientIdentity";
import { isMediaRequest, mediaTrackIdFor, MediaAdmission } from "./MediaAdmission";
import { RequestLimiter, LimitExceeded } from "../core/Limits";
import type { ServerConfig } from "../config/Config";
import type { ServerIdentity } from "../database/Identity";
import type { AssetServiceShape } from "../services/AssetService";
import type { AccessControlShape } from "../services/AccessControl";
import type { AuthPrincipal, AuthServiceShape } from "../services/AuthService";
import type { AdminServiceShape } from "../services/AdminService";
import type { CatalogServiceShape } from "../services/CatalogService";
import type { HomeServiceShape } from "../services/HomeService";
import type { EventServiceShape } from "../services/EventService";
import type { LibraryServiceShape } from "../services/LibraryService";
import type { ScanServiceShape } from "../services/ScanService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import type { JobServiceShape } from "../jobs/JobService";
import type { MetadataSettingsShape } from "../services/MetadataSettings";
import type { ServerNameShape } from "../services/ServerName";
import type { MetadataProvider } from "../media/Tmdb";
import {
  assertBrowserMutation,
  clearedSessionCookie,
  sessionCookie,
  sessionCookieToken,
} from "./BrowserSession";
import { serveFile } from "./ServeFile";
import * as S from "../http/Schemas";

export interface HttpServices {
  readonly auth: AuthServiceShape;
  readonly access: AccessControlShape;
  readonly admin: AdminServiceShape;
  readonly catalog: CatalogServiceShape;
  readonly home: HomeServiceShape;
  readonly events: EventServiceShape;
  readonly libraries: LibraryServiceShape;
  readonly scans: ScanServiceShape;
  readonly assets: AssetServiceShape;
  readonly playback: PlaybackServiceShape;
  readonly tmdb?: MetadataProvider;
  readonly jobs?: JobServiceShape;
  readonly metadataSettings: MetadataSettingsShape;
  readonly databaseReady: () => Promise<boolean>;
  readonly identity: ServerIdentity;
  readonly serverName: ServerNameShape;
  readonly startedAtMs: number;
}

const encode = (schema: Schema.Encoder<unknown, never>, value: unknown): string =>
  JSON.stringify(Schema.encodeUnknownSync(schema)(value));
const json = (
  schema: Schema.Encoder<unknown, never>,
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(encode(schema, value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
const unknownJson = (value: unknown, status = 200): Response => json(Schema.Unknown, value, status);
const ack = (nowMs = Date.now()): Response => json(S.Ack, { ok: true, nowMs });
const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (cause) {
    throw badRequest(cause instanceof Error ? cause.message : "Request validation failed");
  }
};

const body = async (request: Request, maxBytes: number): Promise<unknown> => {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json"))
    throw new ServerError({
      status: 415,
      code: "unsupported_media_type",
      message: "Content-Type must be application/json",
    });
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes)
    throw new ServerError({
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large",
    });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new ServerError({
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large",
    });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
};

const call = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
const bearer = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") === true ? value.slice(7) : null;
};

const errorResponse = (cause: unknown, requestId: string): Response => {
  if (cause instanceof LimitExceeded)
    return json(S.Message, { message: "Rate limit exceeded", requestId }, 429, {
      "retry-after": String(cause.retryAfterSeconds),
      "x-admission-reason": cause.reason ?? "api_rate_or_setup_capacity",
    });
  if (cause instanceof ServerError)
    return json(
      S.Message,
      { message: cause.message, requestId },
      cause.status,
      cause.code === "unauthorized" ? { "www-authenticate": "Bearer" } : {},
    );
  return json(S.Message, { message: "Internal server error", requestId }, 500);
};

const page = (url: URL, withQuery = false) => {
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const cursor = url.searchParams.get("cursor");
  const result = { limit: Number.isSafeInteger(limit) ? limit : Number.NaN, cursor };
  return decode(S.PaginationQuery, withQuery ? result : result);
};

const queryNumber = (url: URL, name: string, fallback: number): number => {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} must be an integer`);
  return parsed;
};

const routeParts = (url: URL): string[] => url.pathname.split("/").filter(Boolean);

export const makeHttpHandler = (
  services: HttpServices,
  config: ServerConfig,
  logger: Logger = createLogger({ level: config.logLevel, format: config.logFormat }),
) => {
  const limiter = new RequestLimiter({
    maxRequests: config.maxRequestsPerMinute,
    loginRequests: config.loginAttemptsPerMinute,
    maxActive: config.maxConcurrentRequests,
  });
  const mediaAdmission = new MediaAdmission(config);
  const mediaSessions = new WeakMap<Request, string>();
  // Session cookies to set once the response exists, keyed by the request that earned them.
  const cookies = new WeakMap<Request, string>();
  /** Renews valid cookie sessions; rejected requests may belong to an older sign-in. */
  const authenticateCookie = async (request: Request, token: string) => {
    const nowMs = Date.now();
    const session = await call(services.auth.authenticateSession(token, nowMs));
    if (session.renewed)
      cookies.set(request, sessionCookie(request, config, token, session.expiresAtMs, nowMs));
    return session;
  };
  /** Desktop clients present a bearer token; the browser app presents its session cookie. */
  const authenticate = async (request: Request): Promise<AuthPrincipal> => {
    const token = bearer(request);
    if (token !== null) return call(services.auth.authenticate(token, Date.now()));
    const cookieToken = sessionCookieToken(request);
    if (cookieToken === null) throw unauthorized();
    if (request.method !== "GET" && request.method !== "HEAD")
      assertBrowserMutation(request, config);
    return (await authenticateCookie(request, cookieToken)).principal;
  };
  /** Starts a browser session: the token goes into the cookie, the account into the body. */
  const browserSession = async (
    request: Request,
    token: string,
    status: number,
  ): Promise<Response> => {
    const nowMs = Date.now();
    const session = await authenticateCookie(request, token);
    cookies.set(request, sessionCookie(request, config, token, session.expiresAtMs, nowMs));
    return json(
      BrowserSession,
      { user: session.principal.user, expiresAtMs: session.expiresAtMs },
      status,
      { "cache-control": "no-store" },
    );
  };
  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const parts = routeParts(url);
    const method = request.method.toUpperCase();
    const authless = method === "GET" && url.pathname === "/health/live";
    if (authless) return unknownJson({ status: "ok" });
    if (method === "GET" && url.pathname === "/api/v1/server") {
      return json(
        ServerInfo,
        {
          serverId: services.identity.installationId,
          displayName: await call(services.serverName.name()),
          apiVersion: API_VERSION,
          serverVersion,
          setupRequired: await call(services.auth.setupRequired()),
          capabilities: { directPlayOnly: true, watchGroups: true, browserSessions: true, trackMemory: true },
        },
        200,
        { "cache-control": "no-store" },
      );
    }
    if (method === "GET" && (url.pathname === "/health/ready" || url.pathname === "/ready")) {
      const ready = await services.databaseReady();
      return unknownJson({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
    }
    if (method === "GET" && url.pathname === "/diagnostics") {
      const principal = await authenticate(request);
      await call(services.access.requireAdmin(principal));
      return unknownJson({
        installationId: services.identity.installationId,
        startedAtMs: services.startedAtMs,
        uptimeMs: Date.now() - services.startedAtMs,
        version: serverVersion,
      });
    }
    if (method === "GET" && url.pathname === "/metrics")
      return new Response(`lumen_uptime_ms ${Date.now() - services.startedAtMs}\n`, {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    if (method === "GET" && url.pathname === "/api/v1/auth/setup") {
      return json(
        Schema.Unknown,
        { setupRequired: await call(services.auth.setupRequired()) },
        200,
        { "cache-control": "no-store" },
      );
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/register") {
      const input = decode(S.RegisterBody, await body(request, config.maxRequestBodyBytes));
      return json(Schema.Unknown, await call(services.auth.register(input, Date.now())), 201);
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/login") {
      const input = decode(S.LoginBody, await body(request, config.maxRequestBodyBytes));
      return json(Schema.Unknown, await call(services.auth.login(input, Date.now())));
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/browser/register") {
      assertBrowserMutation(request, config);
      const input = decode(S.BrowserRegisterBody, await body(request, config.maxRequestBodyBytes));
      const created = await call(
        services.auth.register({ ...input, platform: "web", platformDeviceId: null }, Date.now()),
      );
      return browserSession(request, created.accessToken, 201);
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/browser/login") {
      assertBrowserMutation(request, config);
      const input = decode(S.BrowserLoginBody, await body(request, config.maxRequestBodyBytes));
      const started = await call(
        services.auth.login({ ...input, platform: "web", platformDeviceId: null }, Date.now()),
      );
      return browserSession(request, started.accessToken, 200);
    }
    if (method === "GET" && url.pathname === "/api/v1/auth/browser/session") {
      const token = sessionCookieToken(request);
      if (token === null) throw unauthorized();
      return browserSession(request, token, 200);
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/browser/logout") {
      assertBrowserMutation(request, config);
      const token = sessionCookieToken(request);
      if (token !== null) {
        // A session that already ended has nothing left to revoke. Any other failure leaves the
        // session alive, so it is reported and the cookie is kept rather than cleared.
        const session = await call(services.auth.authenticateSession(token, Date.now())).catch(
          (cause: unknown) => {
            if (cause instanceof ServerError && cause.code === "unauthorized") return null;
            throw cause;
          },
        );
        if (session !== null)
          await call(
            services.auth.logout(session.principal, session.principal.sessionId, Date.now()),
          );
      }
      cookies.set(request, clearedSessionCookie(request, config));
      return ack();
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/migrate-session") {
      const input = decode(S.LegacySessionBody, await body(request, config.maxRequestBodyBytes));
      return json(
        Schema.Unknown,
        await call(services.auth.migrateLegacySession(input.refreshToken, Date.now())),
      );
    }
    const mediaTrackId = mediaTrackIdFor(request);
    if (mediaTrackId !== null) {
      const grant = bearer(request) ?? url.searchParams.get("grant");
      if (grant === null) throw unauthorized("Playback grant is required");
      const media = await call(services.playback.authorizeGrant(grant, mediaTrackId, Date.now()));
      mediaSessions.set(request, media.sessionId);
      const release = mediaAdmission.enterAuthenticated(media.userId, media.sessionId, Date.now());
      try {
        return await serveFile({
          request,
          path: media.absolutePath,
          size: media.size,
          modifiedAtMs: media.modifiedAtMs ?? Date.now(),
          mimeType: media.mimeType,
          preserveIdleTimeout: true,
        });
      } finally {
        release();
      }
    }
    if (url.pathname.startsWith("/api/v1/media/")) throw notFound("Endpoint not found");
    const principal = await authenticate(request);
    if (method === "GET" && url.pathname === "/api/v1/auth/me") return json(User, principal.user);
    if (method === "PUT" && url.pathname === "/api/v1/admin/server") {
      await call(services.access.requireAdmin(principal));
      const input = decode(S.ServerRenameBody, await body(request, config.maxRequestBodyBytes));
      const displayName = input.displayName.trim();
      if (displayName === "") throw badRequest("Server name cannot be empty");
      await call(services.serverName.rename(displayName, Date.now()));
      return unknownJson({ displayName });
    }
    if (
      url.pathname === "/api/v1/admin/metadata-settings" &&
      (method === "GET" || method === "PUT")
    ) {
      await call(services.access.requireAdmin(principal));
      if (method === "PUT") {
        const input = await body(request, config.maxRequestBodyBytes);
        if (
          input === null ||
          typeof input !== "object" ||
          !("tmdbApiKey" in input) ||
          (input.tmdbApiKey !== null && typeof input.tmdbApiKey !== "string") ||
          (typeof input.tmdbApiKey === "string" && input.tmdbApiKey.length > 512)
        ) {
          throw badRequest("Expected a TMDb API key with at most 512 characters, or null");
        }
        const key = input.tmdbApiKey?.trim() ?? null;
        if (input.tmdbApiKey !== null && key === "")
          throw badRequest("TMDb API key cannot be empty");
        await call(services.metadataSettings.setTmdbKey(key, Date.now()));
        if (key !== null)
          await call(services.jobs?.queueMissingMetadata(Date.now()) ?? Effect.void);
      }
      return unknownJson({
        tmdbConfigured: (await call(services.metadataSettings.tmdbKey())) !== null,
      });
    }
    if (
      (method === "POST" && url.pathname === "/api/v1/auth/logout") ||
      (method === "DELETE" &&
        parts[0] === "api" &&
        parts[1] === "v1" &&
        parts[2] === "auth" &&
        parts[3] === "sessions" &&
        parts[4] !== undefined)
    ) {
      const input =
        method === "POST"
          ? decode(S.LogoutBody, await body(request, config.maxRequestBodyBytes))
          : { sessionId: parts[4] ?? "" };
      await call(services.auth.logout(principal, input.sessionId, Date.now()));
      return ack();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users")
      return unknownJson(await call(services.admin.listUsers(principal, Date.now())));
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users")
      return unknownJson(
        await call(
          services.admin.createUser(
            principal,
            decode(S.CreateUserBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
        201,
      );
    if (
      method === "PATCH" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "users" &&
      parts[3] !== undefined
    )
      return unknownJson(
        await call(
          services.admin.updateUser(
            principal,
            parts[3],
            decode(S.UpdateUserBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "users" &&
      parts[3] !== undefined &&
      parts[4] === "devices"
    )
      return unknownJson(await call(services.admin.listDevices(principal, parts[3])));
    if (
      method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "devices" &&
      parts[3] !== undefined
    ) {
      await call(services.admin.revokeDevice(principal, parts[3], Date.now()));
      return ack();
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "users" &&
      parts[3] !== undefined &&
      parts[4] === "sessions"
    )
      return unknownJson(await call(services.admin.listSessions(principal, parts[3], Date.now())));
    if (
      method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "auth" &&
      parts[3] === "sessions" &&
      parts[4] !== undefined
    ) {
      await call(services.admin.revokeSession(principal, parts[4], Date.now()));
      return ack();
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "admin" &&
      parts[3] === "libraries" &&
      parts.length === 4
    )
      return unknownJson(await call(services.admin.listAllLibraries(principal)));
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "admin" &&
      parts[3] === "jobs" &&
      parts.length === 4
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.scans.listRecentJobs(page(url).limit)));
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts.length === 3
    )
      return unknownJson(await call(services.admin.listLibraries(principal, Date.now())));
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts.length === 3
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(
        await call(
          services.libraries.create(
            decode(S.CreateLibraryBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
        201,
      );
    }
    if (
      method === "PATCH" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts.length === 4
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(
        await call(
          services.libraries.update(
            parts[3],
            decode(S.UpdateLibraryBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    }
    if (
      method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts.length === 4
    ) {
      await call(services.access.requireAdmin(principal));
      await call(services.libraries.remove(parts[3]));
      return ack();
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts[3] !== undefined &&
      parts[4] === "roots"
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.libraries.listRoots(parts[3])));
    }
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts[3] !== undefined &&
      parts[4] === "roots"
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(
        await call(
          services.libraries.addRoot(
            decode(S.CreateRootBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
        201,
      );
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts[3] !== undefined &&
      parts[4] === "grants"
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.libraries.listGrants(parts[3])));
    }
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "libraries" &&
      parts[3] !== undefined &&
      parts[4] === "grants"
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(
        await call(
          services.libraries.upsertGrant(
            decode(S.CreateGrantBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    }
    if (
      method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "roots" &&
      parts[3] !== undefined
    ) {
      await call(services.access.requireAdmin(principal));
      await call(services.libraries.deleteRoot(parts[3]));
      return ack();
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "scans") {
      await call(services.access.requireAdmin(principal));
      return unknownJson(
        await call(
          services.libraries.startScan(
            decode(S.StartScanBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
        202,
      );
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "scans" &&
      parts[3] !== undefined &&
      parts[4] === "jobs"
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.scans.listJobs(parts[3])));
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "scans" &&
      parts[3] !== undefined
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.scans.getRun(parts[3])));
    }
    if (method === "GET" && url.pathname === "/api/v1/home") {
      return json(HomeContent, await call(services.home.content(principal, Date.now())));
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts.length === 3
    ) {
      return unknownJson(
        await call(
          services.catalog.listItems(
            principal,
            url.searchParams.get("libraryId"),
            page(url),
            Date.now(),
          ),
        ),
      );
    }
    if (
      (method === "GET" || method === "PUT") &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "episode-order" &&
      parts.length === 5
    ) {
      await call(services.access.requireAdmin(principal));
      if (services.tmdb === undefined) throw badRequest("Episode orders are unavailable");
      if (method === "GET")
        return json(EpisodeOrderOptions, await call(services.tmdb.episodeOrder(parts[3])));
      if (services.jobs === undefined) throw badRequest("Metadata refresh is unavailable");
      await call(
        services.tmdb.setEpisodeOrder(
          parts[3],
          decode(EpisodeOrderSelection, await body(request, config.maxRequestBodyBytes)),
        ),
      );
      return unknownJson({ runId: await call(services.jobs.refresh(parts[3], Date.now())) });
    }
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "refresh"
    ) {
      await call(services.access.requireAdmin(principal));
      if (services.jobs === undefined) throw badRequest("Metadata refresh is unavailable");
      await call(services.jobs.refresh(parts[3], Date.now()));
      return ack();
    }
    if (
      method === "PATCH" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "metadata"
    ) {
      await call(services.access.requireAdmin(principal));
      await call(
        services.catalog.updateItemMetadata(
          parts[3],
          decode(S.ItemMetadataBody, await body(request, config.maxRequestBodyBytes)),
          Date.now(),
        ),
      );
      return ack();
    }
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "match"
    ) {
      await call(services.access.requireAdmin(principal));
      await call(
        services.catalog.matchItem(
          parts[3],
          decode(S.ItemMatchBody, await body(request, config.maxRequestBodyBytes)),
        ),
      );
      if (services.jobs !== undefined) await call(services.jobs.refresh(parts[3], Date.now()));
      return ack();
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "children"
    ) {
      return unknownJson(
        await call(services.catalog.listItemChildren(principal, parts[3], page(url), Date.now())),
      );
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "next-up"
    ) {
      return unknownJson(await call(services.catalog.nextUp(principal, parts[3], Date.now())));
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined
    ) {
      return unknownJson(
        await call(
          services.catalog.itemDetails(
            principal,
            parts[3],
            (await call(services.metadataSettings.tmdbKey())) !== null,
            Date.now(),
          ),
        ),
      );
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "tracks")
      return unknownJson(
        await call(
          services.catalog.listTracks(
            principal,
            url.searchParams.get("libraryId"),
            page(url),
            Date.now(),
          ),
        ),
      );
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "favorite"
    ) {
      await call(
        services.catalog.setItemFavorite(
          principal,
          parts[3],
          decode(S.FavoriteBody, await body(request, config.maxRequestBodyBytes)),
          Date.now(),
        ),
      );
      return ack();
    }
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "items" &&
      parts[3] !== undefined &&
      parts[4] === "watch-state"
    ) {
      await call(
        services.catalog.setItemWatchState(
          principal,
          parts[3],
          decode(S.ItemWatchStateBody, await body(request, config.maxRequestBodyBytes)),
          Date.now(),
        ),
      );
      return ack();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "search") {
      const input = decode(S.SearchQuery, {
        q: url.searchParams.get("q"),
        libraryId: url.searchParams.get("libraryId"),
        limit: queryNumber(url, "limit", 25),
        cursor: url.searchParams.get("cursor"),
      });
      return unknownJson(await call(services.catalog.searchItems(principal, input, Date.now())));
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "tracks" &&
      parts[3] !== undefined
    )
      return unknownJson(
        await call(services.catalog.trackDetails(principal, parts[3], Date.now())),
      );
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "tracks" &&
      parts[3] !== undefined &&
      parts[4] === "favorite"
    ) {
      await call(
        services.catalog.setFavorite(
          principal,
          parts[3],
          decode(S.FavoriteBody, await body(request, config.maxRequestBodyBytes)),
          Date.now(),
        ),
      );
      return ack();
    }
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "tracks" &&
      parts[3] !== undefined &&
      parts[4] === "watch-state"
    )
      return unknownJson(
        await call(
          services.catalog.setWatchState(
            principal,
            parts[3],
            decode(S.WatchStateBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    if (url.pathname === "/api/v1/me/track-preferences") {
      if (method === "GET")
        return unknownJson(await call(services.playback.preferences(principal)));
      if (method === "PATCH")
        return unknownJson(
          await call(
            services.playback.updatePreferences(
              principal,
              decode(TrackPreferencesPatch, await body(request, config.maxRequestBodyBytes)),
            ),
          ),
        );
    }
    if (
      method === "PUT" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "playback" &&
      parts[3] === "sessions" &&
      parts[4] !== undefined &&
      parts[5] === "track-choice" &&
      parts[6] === undefined
    ) {
      return unknownJson(
        await call(
          services.playback.saveChoice(
            principal,
            parts[4],
            decode(TrackChoiceInput, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    }
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "playback" &&
      parts[3] === "sessions" &&
      parts[4] === undefined
    ) {
      const input = decode(S.StartPlaybackBody, await body(request, config.maxRequestBodyBytes));
      const result = await call(services.playback.start(principal, input, Date.now()));
      return unknownJson(
        {
          sessionId: result.session.id,
          itemId: result.itemId,
          sourceId: result.sourceId,
          sourceGeneration: result.sourceGeneration,
          title: result.title,
          streamUrl: result.streamPath,
          durationSeconds: result.durationSeconds,
          streams: result.streams,
          trackMemory: result.trackMemory,
          grantExpiresInSeconds: result.grantExpiresInSeconds,
          grantToken: result.grantToken,
          mode: "DirectPlay",
        },
        201,
      );
    }
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "playback" &&
      parts[3] === "sessions" &&
      parts[4] !== undefined &&
      parts[5] === "heartbeat"
    )
      return unknownJson(
        await call(
          services.playback.heartbeat(
            principal,
            parts[4],
            decode(S.HeartbeatBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );
    if (
      method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "playback" &&
      parts[3] === "sessions" &&
      parts[4] !== undefined
    ) {
      await call(services.playback.stop(principal, parts[4], Date.now()));
      return ack();
    }
    if (
      method === "POST" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "playback" &&
      parts[3] === "sessions" &&
      parts[4] !== undefined &&
      parts[5] === "progress"
    )
      return unknownJson(
        await call(
          services.playback.progress(
            principal,
            parts[4],
            decode(S.ProgressBody, await body(request, config.maxRequestBodyBytes)),
            Date.now(),
          ),
        ),
      );

    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "events") {
      const after = queryNumber(url, "after", 0);
      return new Response(services.events.stream(after, principal.user.id, request.signal), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "artwork" &&
      parts[3] !== undefined
    ) {
      const asset = await call(services.assets.artwork(principal, parts[3], Date.now()));
      return serveFile({
        request,
        path: asset.path,
        size: asset.size,
        modifiedAtMs: asset.modifiedAtMs,
        mimeType: asset.mimeType,
      });
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "sidecars" &&
      parts[3] !== undefined
    ) {
      const asset = await call(services.assets.sidecar(principal, parts[3], Date.now()));
      return serveFile({
        request,
        path: asset.path,
        size: asset.size,
        modifiedAtMs: asset.modifiedAtMs,
        mimeType: asset.mimeType,
      });
    }
    if (
      method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "library-roots" &&
      parts[3] !== undefined
    ) {
      await call(services.access.requireAdmin(principal));
      return unknownJson(await call(services.libraries.listRoots(parts[3])));
    }
    throw notFound("Endpoint not found");
  };
  return async (request: Request, context?: RequestContext): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = requestIdFor(request);
    const pathname = new URL(request.url).pathname;
    const log = logger.child({
      component: "http",
      requestId,
      method: requestMethod(request.method),
      route: requestRoute(pathname),
    });
    let response: Response;
    let failure: unknown;
    const key = clientKey(request, context, config.trustedProxies);
    const media = isMediaRequest(request);
    const login = [
      "/auth/login",
      "/auth/register",
      "/auth/migrate-session",
      "/auth/browser/login",
      "/auth/browser/register",
    ].some((path) => pathname.endsWith(path));
    try {
      if (media) {
        const release = mediaAdmission.enterPeer(key, Date.now());
        try {
          response = await dispatch(request);
        } finally {
          release();
        }
      } else {
        const execute = Effect.tryPromise({
          try: () => dispatch(request),
          catch: (cause) => cause,
        });
        const checked = limiter.check(key, Date.now(), login ? "login" : "request");
        response = await Effect.runPromise(
          checked.pipe(Effect.flatMap(() => limiter.run(key, execute))),
        );
      }
    } catch (cause) {
      failure = cause;
      response = errorResponse(cause, requestId);
    }
    // A valid file transfer may stop reading indefinitely while the player is paused.
    // Keep ordinary API/denied requests on the transport's default timeout.
    if (media && request.method === "GET" && (response.status === 200 || response.status === 206))
      context?.disableIdleTimeout?.();
    response.headers.set("x-request-id", requestId);
    const cookie = cookies.get(request);
    if (cookie !== undefined) response.headers.append("set-cookie", cookie);
    // What the API returns belongs to one signed-in person; shared caches must not keep it.
    if (pathname.startsWith("/api/") && !response.headers.has("cache-control"))
      response.headers.set("cache-control", "private, no-store");
    const level =
      response.status >= 500
        ? "error"
        : response.status >= 400
          ? "warn"
          : isRoutineProbe(pathname)
            ? "debug"
            : "info";
    log[level](
      "http_request",
      {
        status: response.status,
        ...(media
          ? {
              range: requestRange(request),
              playbackSessionId: mediaSessions.get(request),
              admission:
                failure instanceof LimitExceeded ? (failure.reason ?? "rate_limited") : "accepted",
              expectedResponseBytes:
                request.method === "HEAD"
                  ? 0
                  : response.headers.has("content-length")
                    ? Number(response.headers.get("content-length"))
                    : null,
            }
          : {}),
        // Response creation time; media and SSE bodies may continue streaming.
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorCode:
          failure instanceof ServerError
            ? failure.code
            : failure instanceof LimitExceeded
              ? "rate_limited"
              : undefined,
      },
      response.status >= 500 ? failure : undefined,
    );
    return response;
  };
};
