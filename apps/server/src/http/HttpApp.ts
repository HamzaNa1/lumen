import { User } from "@lumen/contracts";
import { Effect, Schema } from "effect";
import { decideConditional, decideRange } from "../core/RangePolicy";
import { badRequest, notFound, ServerError, unauthorized } from "../core/Errors";
import { newUuid } from "../core/Security";
import { RequestLimiter, LimitExceeded } from "../core/Limits";
import { lstat } from "node:fs/promises";
import type { ServerConfig } from "../config/Config";
import type { ServerIdentity } from "../database/Identity";
import type { AssetServiceShape } from "../services/AssetService";
import type { AccessControlShape } from "../services/AccessControl";
import type { AuthPrincipal, AuthServiceShape } from "../services/AuthService";
import type { AdminServiceShape } from "../services/AdminService";
import type { CatalogServiceShape } from "../services/CatalogService";
import type { EventServiceShape } from "../services/EventService";
import type { LibraryServiceShape } from "../services/LibraryService";
import type { ScanServiceShape } from "../services/ScanService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import type { JobServiceShape } from "../jobs/JobService";
import type { MetadataSettingsShape } from "../services/MetadataSettings";
import * as S from "../http/Schemas";

export interface HttpServices {
  readonly auth: AuthServiceShape;
  readonly access: AccessControlShape;
  readonly admin: AdminServiceShape;
  readonly catalog: CatalogServiceShape;
  readonly events: EventServiceShape;
  readonly libraries: LibraryServiceShape;
  readonly scans: ScanServiceShape;
  readonly assets: AssetServiceShape;
  readonly playback: PlaybackServiceShape;
  readonly jobs?: JobServiceShape;
  readonly metadataSettings: MetadataSettingsShape;
  readonly databaseReady: () => Promise<boolean>;
  readonly identity: ServerIdentity;
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

const clientKey = (request: Request): string =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  request.headers.get("x-real-ip") ??
  "local";

const errorResponse = (cause: unknown, requestId: string): Response => {
  if (cause instanceof LimitExceeded)
    return json(S.Message, { message: "Rate limit exceeded", requestId }, 429, {
      "retry-after": String(cause.retryAfterSeconds),
    });
  if (cause instanceof ServerError)
    return json(
      S.Message,
      { message: cause.message, requestId },
      cause.status,
      cause.code === "unauthorized" ? { "www-authenticate": "Bearer" } : {},
    );
  console.error("request_failed", {
    requestId,
    error: cause instanceof Error ? cause.message : String(cause),
  });
  return json(S.Message, { message: "Internal server error", requestId }, 500);
};

const page = (url: URL, withQuery = false) => {
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const cursor = url.searchParams.get("cursor");
  const result = { limit: Number.isSafeInteger(limit) ? limit : Number.NaN, cursor };
  return decode(S.PaginationQuery, withQuery ? result : result);
};

const date = (value: number): string => new Date(value).toUTCString();

const serveFile = async (options: {
  readonly request: Request;
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly mimeType: string;
}): Promise<Response> => {
  const details = await lstat(options.path);
  if (!details.isFile() || details.isSymbolicLink()) throw notFound("Media file is unavailable");
  const etag = `W/"${options.size.toString(16)}-${Math.trunc(options.modifiedAtMs).toString(16)}"`;
  const lastModified = date(options.modifiedAtMs);
  const condition = decideConditional({
    method: options.request.method,
    ifMatch: options.request.headers.get("if-match"),
    ifNoneMatch: options.request.headers.get("if-none-match"),
    ifModifiedSince: options.request.headers.get("if-modified-since"),
    ifUnmodifiedSince: options.request.headers.get("if-unmodified-since"),
    lastModified,
    etag,
    nowMs: Date.now(),
  });
  const common = {
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, must-revalidate",
    etag,
    "last-modified": lastModified,
    "content-type": options.mimeType,
    "x-content-type-options": "nosniff",
  };
  if (condition === "precondition_failed")
    return new Response(null, { status: 412, headers: common });
  if (condition === "not_modified") return new Response(null, { status: 304, headers: common });
  const ifRange = options.request.headers.get("if-range");
  const rangeHeader =
    options.request.method === "HEAD" || (ifRange !== null && ifRange !== etag)
      ? null
      : options.request.headers.get("range");
  const range = decideRange(rangeHeader, options.size);
  if (range.kind === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...common, "content-range": `bytes */${options.size}` },
    });
  if (options.size === 0) {
    return new Response(null, { status: 200, headers: { ...common, "content-length": "0" } });
  }
  const start = range.kind === "ignored" || range.kind === "full" ? 0 : range.start;
  const end =
    range.kind === "ignored" || range.kind === "full" ? Math.max(0, options.size - 1) : range.end;
  const bodyFile = Bun.file(options.path).slice(start, options.size === 0 ? 0 : end + 1);
  const headers: Record<string, string> = {
    ...common,
    "content-length": String(Math.max(0, end - start + 1)),
  };
  if (range.kind === "partial") headers["content-range"] = `bytes ${start}-${end}/${options.size}`;
  if (options.request.method === "HEAD" || options.size === 0)
    return new Response(null, { status: range.kind === "partial" ? 206 : 200, headers });
  return new Response(bodyFile, { status: range.kind === "partial" ? 206 : 200, headers });
};

const queryNumber = (url: URL, name: string, fallback: number): number => {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} must be an integer`);
  return parsed;
};

const routeParts = (url: URL): string[] => url.pathname.split("/").filter(Boolean);

export const makeHttpHandler = (services: HttpServices, config: ServerConfig) => {
  const limiter = new RequestLimiter({
    maxRequests: config.maxRequestsPerMinute,
    loginRequests: config.loginAttemptsPerMinute,
    maxActive: config.maxConcurrentRequests,
  });
  const authenticate = async (request: Request): Promise<AuthPrincipal> => {
    const token = bearer(request);
    if (token === null) throw unauthorized();
    return call(services.auth.authenticate(token, Date.now()));
  };
  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const parts = routeParts(url);
    const method = request.method.toUpperCase();
    const authless = method === "GET" && url.pathname === "/health/live";
    if (authless) return unknownJson({ status: "ok" });
    if (method === "GET" && url.pathname === "/api/v1/server") {
      return json(
        Schema.Unknown,
        {
          serverId: services.identity.installationId,
          displayName: "Lumen",
          apiVersion: "1.0.0",
          setupRequired: await call(services.auth.setupRequired()),
          capabilities: { directPlayOnly: true },
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
        version: "0.1.0",
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
    if (method === "POST" && url.pathname === "/api/v1/auth/migrate-session") {
      const input = decode(S.LegacySessionBody, await body(request, config.maxRequestBodyBytes));
      return json(
        Schema.Unknown,
        await call(services.auth.migrateLegacySession(input.refreshToken, Date.now())),
      );
    }
    if (
      (method === "GET" || method === "HEAD") &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "media" &&
      parts[3] !== undefined
    ) {
      const grant = bearer(request) ?? url.searchParams.get("grant");
      if (grant === null) throw unauthorized("Playback grant is required");
      const media = await call(services.playback.authorizeGrant(grant, parts[3], Date.now()));
      return serveFile({
        request,
        path: media.absolutePath,
        size: media.size,
        modifiedAtMs: media.modifiedAtMs ?? Date.now(),
        mimeType: media.mimeType,
      });
    }
    const principal = await authenticate(request);
    if (method === "GET" && url.pathname === "/api/v1/auth/me") return json(User, principal.user);
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
      return unknownJson(await call(services.admin.listUsers(principal)));
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
  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) ?? newUuid();
    const key = clientKey(request);
    const login = ["/auth/login", "/auth/register", "/auth/migrate-session"].some((path) =>
      new URL(request.url).pathname.endsWith(path),
    );
    try {
      const execute = Effect.tryPromise({ try: () => dispatch(request), catch: (cause) => cause });
      const checked = limiter.check(key, Date.now(), login ? "login" : "request");
      return await Effect.runPromise(checked.pipe(Effect.flatMap(() => limiter.run(key, execute))));
    } catch (cause) {
      return errorResponse(cause, requestId);
    }
  };
};
