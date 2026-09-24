import { User } from "@lumen/contracts";
import { sql, type Database } from "@lumen/database";
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
  readonly database: Database["Service"];
  readonly databaseReady: () => Promise<boolean>;
  readonly identity: ServerIdentity;
  readonly startedAtMs: number;
}

const encode = (schema: Schema.Encoder<unknown, never>, value: unknown): string => JSON.stringify(Schema.encodeUnknownSync(schema)(value));
const json = (schema: Schema.Encoder<unknown, never>, value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(encode(schema, value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
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
  if (!contentType.toLowerCase().startsWith("application/json")) throw new ServerError({ status: 415, code: "unsupported_media_type", message: "Content-Type must be application/json" });
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) throw new ServerError({ status: 413, code: "payload_too_large", message: "Request body is too large" });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ServerError({ status: 413, code: "payload_too_large", message: "Request body is too large" });
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

const clientKey = (request: Request): string => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "local";

const errorResponse = (cause: unknown, requestId: string): Response => {
  if (cause instanceof LimitExceeded) return json(S.Message, { message: "Rate limit exceeded", requestId }, 429, { "retry-after": String(cause.retryAfterSeconds) });
  if (cause instanceof ServerError) return json(S.Message, { message: cause.message, requestId }, cause.status, cause.code === "unauthorized" ? { "www-authenticate": "Bearer" } : {});
  console.error("request_failed", { requestId, error: cause instanceof Error ? cause.message : String(cause) });
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
  if (condition === "precondition_failed") return new Response(null, { status: 412, headers: common });
  if (condition === "not_modified") return new Response(null, { status: 304, headers: common });
  const ifRange = options.request.headers.get("if-range");
  const rangeHeader = options.request.method === "HEAD" || ifRange !== null && ifRange !== etag ? null : options.request.headers.get("range");
  const range = decideRange(rangeHeader, options.size);
  if (range.kind === "unsatisfiable") return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${options.size}` } });
  if (options.size === 0) {
    return new Response(null, { status: 200, headers: { ...common, "content-length": "0" } });
  }
  const start = range.kind === "ignored" || range.kind === "full" ? 0 : range.start;
  const end = range.kind === "ignored" || range.kind === "full" ? Math.max(0, options.size - 1) : range.end;
  const bodyFile = Bun.file(options.path).slice(start, options.size === 0 ? 0 : end + 1);
  const headers: Record<string, string> = { ...common, "content-length": String(Math.max(0, end - start + 1)) };
  if (range.kind === "partial") headers["content-range"] = `bytes ${start}-${end}/${options.size}`;
  if (options.request.method === "HEAD" || options.size === 0) return new Response(null, { status: range.kind === "partial" ? 206 : 200, headers });
  return new Response(bodyFile, { status: range.kind === "partial" ? 206 : 200, headers });
};

const queryNumber = (url: URL, name: string, fallback: number): number => {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} must be an integer`);
  return parsed;
};

const decodeCursor = (cursor: string | null | undefined): number => {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest("Invalid cursor");
  return value;
};

const encodeCursor = (offset: number): string => Buffer.from(String(offset), "utf8").toString("base64url");

const routeParts = (url: URL): string[] => url.pathname.split("/").filter(Boolean);

export const makeHttpHandler = (services: HttpServices, config: ServerConfig) => {
  const limiter = new RequestLimiter({ maxRequests: config.maxRequestsPerMinute, loginRequests: config.loginAttemptsPerMinute, maxActive: config.maxConcurrentRequests });
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
      return json(Schema.Unknown, { serverId: services.identity.installationId, displayName: "Lumen", apiVersion: "1.0.0", setupRequired: await call(services.auth.setupRequired()), capabilities: { directPlayOnly: true } }, 200, { "cache-control": "no-store" });
    }
    if (method === "GET" && (url.pathname === "/health/ready" || url.pathname === "/ready")) {
      const ready = await services.databaseReady();
      return unknownJson({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
    }
    if (method === "GET" && url.pathname === "/diagnostics") {
      const principal = await authenticate(request);
      await call(services.access.requireAdmin(principal));
      return unknownJson({ installationId: services.identity.installationId, startedAtMs: services.startedAtMs, uptimeMs: Date.now() - services.startedAtMs, version: "0.1.0" });
    }
    if (method === "GET" && url.pathname === "/metrics") return new Response(`lumen_uptime_ms ${Date.now() - services.startedAtMs}\n`, { headers: { "content-type": "text/plain; version=0.0.4" } });
    if (method === "GET" && url.pathname === "/api/v1/auth/setup") {
      return json(Schema.Unknown, { setupRequired: await call(services.auth.setupRequired()) }, 200, { "cache-control": "no-store" });
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/register") {
      const input = decode(S.RegisterBody, await body(request, config.maxRequestBodyBytes));
      return json(Schema.Unknown, await call(services.auth.register(input, Date.now())), 201);
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/login") {
      const input = decode(S.LoginBody, await body(request, config.maxRequestBodyBytes));
      return json(Schema.Unknown, await call(services.auth.login(input, Date.now())));
    }
    if (method === "POST" && url.pathname === "/api/v1/auth/refresh") {
      const input = decode(S.RefreshBody, await body(request, config.maxRequestBodyBytes));
      return json(Schema.Unknown, await call(services.auth.refresh(input, Date.now())));
    }
    if ((method === "GET" || method === "HEAD") && parts[0] === "api" && parts[1] === "v1" && parts[2] === "media" && parts[3] !== undefined) {
      const grant = bearer(request) ?? url.searchParams.get("grant");
      if (grant === null) throw unauthorized("Playback grant is required");
      const media = await call(services.playback.authorizeGrant(grant, parts[3], Date.now()));
      return serveFile({ request, path: media.absolutePath, size: media.size, modifiedAtMs: media.modifiedAtMs ?? Date.now(), mimeType: media.mimeType });
    }
    const principal = await authenticate(request);
    if (method === "GET" && url.pathname === "/api/v1/auth/me") return json(User, principal.user);
    if (url.pathname === "/api/v1/admin/metadata-settings" && (method === "GET" || method === "PUT")) {
      await call(services.access.requireAdmin(principal));
      if (method === "PUT") {
        const input = await body(request, config.maxRequestBodyBytes);
        if (input === null || typeof input !== "object" || !("tmdbApiKey" in input) ||
          (input.tmdbApiKey !== null && typeof input.tmdbApiKey !== "string") ||
          (typeof input.tmdbApiKey === "string" && input.tmdbApiKey.length > 512)) {
          throw badRequest("Expected a TMDb API key with at most 512 characters, or null");
        }
        const key = input.tmdbApiKey?.trim() ?? null;
        if (input.tmdbApiKey !== null && key === "") throw badRequest("TMDb API key cannot be empty");
        await call(services.metadataSettings.setTmdbKey(key, Date.now()));
        if (key !== null) await call(services.jobs?.queueMissingMetadata(Date.now()) ?? Effect.void);
      }
      return unknownJson({ tmdbConfigured: (await call(services.metadataSettings.tmdbKey())) !== null });
    }
    if ((method === "POST" && url.pathname === "/api/v1/auth/logout") || (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "auth" && parts[3] === "sessions" && parts[4] !== undefined)) {
      const input = method === "POST" ? decode(S.LogoutBody, await body(request, config.maxRequestBodyBytes)) : { sessionId: parts[4] ?? "" };
      await call(services.auth.logout(principal, input.sessionId, Date.now()));
      return ack();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users") return unknownJson(await call(services.admin.listUsers(principal)));
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users") return unknownJson(await call(services.admin.createUser(principal, decode(S.CreateUserBody, await body(request, config.maxRequestBodyBytes)), Date.now())), 201);
    if (method === "PATCH" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users" && parts[3] !== undefined) return unknownJson(await call(services.admin.updateUser(principal, parts[3], decode(S.UpdateUserBody, await body(request, config.maxRequestBodyBytes)), Date.now())));
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users" && parts[3] !== undefined && parts[4] === "devices") return unknownJson(await call(services.admin.listDevices(principal, parts[3])));
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "devices" && parts[3] !== undefined) { await call(services.admin.revokeDevice(principal, parts[3], Date.now())); return ack(); }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "users" && parts[3] !== undefined && parts[4] === "sessions") return unknownJson(await call(services.admin.listSessions(principal, parts[3], Date.now())));
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "auth" && parts[3] === "sessions" && parts[4] !== undefined) { await call(services.admin.revokeSession(principal, parts[4], Date.now())); return ack(); }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "admin" && parts[3] === "libraries" && parts.length === 4) return unknownJson(await call(services.admin.listAllLibraries(principal)));
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts.length === 3) return unknownJson(await call(services.admin.listLibraries(principal, Date.now())));
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts.length === 3) { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.create(decode(S.CreateLibraryBody, await body(request, config.maxRequestBodyBytes)), Date.now())), 201); }
    if (method === "PATCH" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts.length === 4) { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.update(parts[3], decode(S.UpdateLibraryBody, await body(request, config.maxRequestBodyBytes)), Date.now()))); }
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts.length === 4) { await call(services.access.requireAdmin(principal)); await call(services.libraries.remove(parts[3])); return ack(); }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts[3] !== undefined && parts[4] === "roots") { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.listRoots(parts[3]))); }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts[3] !== undefined && parts[4] === "roots") { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.addRoot(decode(S.CreateRootBody, await body(request, config.maxRequestBodyBytes)), Date.now())), 201); }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts[3] !== undefined && parts[4] === "grants") { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.listGrants(parts[3]))); }
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "libraries" && parts[3] !== undefined && parts[4] === "grants") { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.upsertGrant(decode(S.CreateGrantBody, await body(request, config.maxRequestBodyBytes)), Date.now()))); }
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "roots" && parts[3] !== undefined) { await call(services.access.requireAdmin(principal)); await call(services.libraries.deleteRoot(parts[3])); return ack(); }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "scans") { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.startScan(decode(S.StartScanBody, await body(request, config.maxRequestBodyBytes)), Date.now())), 202); }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "scans" && parts[3] !== undefined && parts[4] === "jobs") return unknownJson(await call(services.scans.listJobs(parts[3])));
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "scans" && parts[3] !== undefined) return unknownJson(await call(services.scans.getRun(parts[3])));
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts.length === 3) {
      const libraryId = url.searchParams.get("libraryId");
      const pagination = page(url);
      const offset = decodeCursor(pagination.cursor);
      if (libraryId !== null) await call(services.access.requireLibrary(principal, libraryId, "library:read", Date.now()));
      const libraryIds = libraryId === null ? await call(services.access.accessibleLibraryIds(principal, Date.now())) : [libraryId];
      if (libraryIds.length === 0) return unknownJson({ items: [], nextCursor: null });
      const placeholders = libraryIds.map((id) => sql`${id}`);
      type CatalogItemRow = {
        id: string;
        libraryId: string;
        title: string;
        kind: string;
        durationMs: number | null;
        year: number | null;
        artworkId: string | null;
        resumePositionSeconds: number | null;
      };
      const rows = (await call(services.database.all<CatalogItemRow>(sql`
        SELECT i.id, i.library_id AS libraryId, i.title, i.kind,
          i.duration_seconds * 1000 AS durationMs, i.year,
          (SELECT a.artwork_id FROM catalog_item_artwork a WHERE a.item_id = i.id AND a.role = 'poster') AS artworkId,
          w.position_seconds AS resumePositionSeconds
        FROM catalog_items i
        LEFT JOIN item_watch_states w ON w.item_id = i.id AND w.user_id = ${principal.user.id}
        WHERE i.library_id IN (${sql.join(placeholders, sql`, `)}) AND i.parent_id IS NULL
        ORDER BY i.sort_title ASC, i.id ASC
        LIMIT ${pagination.limit + 1} OFFSET ${offset}
      `))) as ReadonlyArray<CatalogItemRow>;
      const hasMore = rows.length > pagination.limit;
      return unknownJson({ items: rows.slice(0, pagination.limit), nextCursor: hasMore ? encodeCursor(offset + pagination.limit) : null });
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "refresh") {
      await call(services.access.requireAdmin(principal));
      if (services.jobs === undefined) throw badRequest("Metadata refresh is unavailable");
      await call(services.jobs.refresh(parts[3], Date.now()));
      return ack();
    }
    if (method === "PATCH" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "metadata") {
      await call(services.access.requireAdmin(principal));
      const input = decode(Schema.Struct({
        title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
        overview: Schema.optional(Schema.NullOr(Schema.String)),
        year: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1800, maximum: 9999 })))),
        releaseDate: Schema.optional(Schema.NullOr(Schema.String)),
        contentRating: Schema.optional(Schema.NullOr(Schema.String)),
        communityRating: Schema.optional(Schema.NullOr(Schema.Number)),
        genres: Schema.optional(Schema.Array(Schema.String)),
        studios: Schema.optional(Schema.Array(Schema.String)),
        tags: Schema.optional(Schema.Array(Schema.String)),
      }), await body(request, config.maxRequestBodyBytes));
      const old = await call(services.database.get<{ title: string; overview: string | null; year: number | null; releaseDate: string | null; contentRating: string | null; communityRating: number | null; genresJson: string | null; studiosJson: string | null; tagsJson: string | null; externalIdsJson: string | null; fieldSourcesJson: string | null; lockedFieldsJson: string | null }>(sql`
        SELECT i.title, i.overview, i.year, m.release_date AS releaseDate, m.content_rating AS contentRating,
          m.community_rating AS communityRating, m.genres_json AS genresJson, m.studios_json AS studiosJson,
          m.tags_json AS tagsJson, m.external_ids_json AS externalIdsJson, m.field_sources_json AS fieldSourcesJson,
          m.locked_fields_json AS lockedFieldsJson FROM catalog_items i LEFT JOIN catalog_item_metadata m ON m.item_id = i.id WHERE i.id = ${parts[3]}
      `));
      if (old == null) throw notFound("Item not found");
      const locks = new Set(JSON.parse(old.lockedFieldsJson ?? "[]") as string[]);
      const sources = JSON.parse(old.fieldSourcesJson ?? "{}") as Record<string, string>;
      for (const key of Object.keys(input)) { locks.add(key); sources[key] = "user"; }
      const title = input.title ?? old.title;
      await call(services.database.run(sql`
        UPDATE catalog_items SET title = ${title}, sort_title = ${title.toLowerCase()},
          overview = ${input.overview === undefined ? old.overview : input.overview},
          year = ${input.year === undefined ? old.year : input.year}, metadata_state = 'user',
          updated_at_ms = unixepoch() * 1000 WHERE id = ${parts[3]}
      `));
      await call(services.database.run(sql`
        INSERT INTO catalog_item_metadata(item_id, release_date, content_rating, community_rating,
          genres_json, studios_json, tags_json, external_ids_json, field_sources_json, locked_fields_json)
        VALUES (${parts[3]}, ${input.releaseDate === undefined ? old.releaseDate : input.releaseDate},
          ${input.contentRating === undefined ? old.contentRating : input.contentRating},
          ${input.communityRating === undefined ? old.communityRating : input.communityRating},
          ${JSON.stringify(input.genres ?? JSON.parse(old.genresJson ?? "[]"))},
          ${JSON.stringify(input.studios ?? JSON.parse(old.studiosJson ?? "[]"))},
          ${JSON.stringify(input.tags ?? JSON.parse(old.tagsJson ?? "[]"))},
          ${old.externalIdsJson ?? "{}"}, ${JSON.stringify(sources)}, ${JSON.stringify([...locks])})
        ON CONFLICT(item_id) DO UPDATE SET release_date = excluded.release_date, content_rating = excluded.content_rating,
          community_rating = excluded.community_rating, genres_json = excluded.genres_json, studios_json = excluded.studios_json,
          tags_json = excluded.tags_json, field_sources_json = excluded.field_sources_json, locked_fields_json = excluded.locked_fields_json
      `));
      return ack();
    }
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "match") {
      await call(services.access.requireAdmin(principal));
      const input = decode(Schema.Struct({ tmdbId: Schema.String.check(Schema.isPattern(/^\d+$/u)) }), await body(request, config.maxRequestBodyBytes));
      const item = await call(services.database.get<{ kind: string }>(sql`SELECT kind FROM catalog_items WHERE id = ${parts[3]}`));
      if (item == null || (item.kind !== "movie" && item.kind !== "show")) throw badRequest("Choose a movie or series");
      const existing = await call(services.database.get<{ externalIdsJson: string; fieldSourcesJson: string; lockedFieldsJson: string }>(sql`
        SELECT external_ids_json AS externalIdsJson, field_sources_json AS fieldSourcesJson,
          locked_fields_json AS lockedFieldsJson FROM catalog_item_metadata WHERE item_id = ${parts[3]}
      `));
      const externalIds = { ...JSON.parse(existing?.externalIdsJson ?? "{}") as Record<string, string>, tmdb: input.tmdbId };
      const fieldSources = { ...JSON.parse(existing?.fieldSourcesJson ?? "{}") as Record<string, string>, tmdb: "user" };
      const locks = new Set(JSON.parse(existing?.lockedFieldsJson ?? "[]") as string[]);
      locks.add("tmdb");
      await call(services.database.run(sql`
        INSERT INTO catalog_item_metadata(item_id, external_ids_json, field_sources_json, locked_fields_json)
        VALUES (${parts[3]}, ${JSON.stringify(externalIds)}, ${JSON.stringify(fieldSources)}, ${JSON.stringify([...locks])})
        ON CONFLICT(item_id) DO UPDATE SET external_ids_json = excluded.external_ids_json,
          field_sources_json = excluded.field_sources_json, locked_fields_json = excluded.locked_fields_json
      `));
      await call(services.database.run(sql`
        WITH RECURSIVE descendants(id) AS (SELECT id FROM catalog_items WHERE id = ${parts[3]}
          UNION ALL SELECT i.id FROM catalog_items i JOIN descendants d ON i.parent_id = d.id)
        DELETE FROM provider_records WHERE item_id IN (SELECT id FROM descendants) AND provider = 'tmdb'
      `));
      if (services.jobs !== undefined) await call(services.jobs.refresh(parts[3], Date.now()));
      return ack();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "children") {
      const parent = await call(services.database.get<{ libraryId: string; kind: string }>(sql`SELECT library_id AS libraryId, kind FROM catalog_items WHERE id = ${parts[3]}`));
      if (parent == null) throw notFound("Item not found");
      await call(services.access.requireLibrary(principal, parent.libraryId, "library:read", Date.now()));
      const pagination = page(url);
      const offset = decodeCursor(pagination.cursor);
      const rows = await call(services.database.all(sql`
        SELECT i.id, i.library_id AS libraryId, i.parent_id AS parentId, i.title, i.kind,
          i.index_number AS indexNumber, i.duration_seconds * 1000 AS durationMs, i.year,
          (SELECT a.artwork_id FROM catalog_item_artwork a WHERE a.item_id = i.id AND a.role IN ('poster', 'still') ORDER BY a.role LIMIT 1) AS artworkId,
          w.position_seconds AS resumePositionSeconds
        FROM catalog_items i
        LEFT JOIN item_watch_states w ON w.item_id = i.id AND w.user_id = ${principal.user.id}
        WHERE i.parent_id = ${parts[3]} AND i.library_id = ${parent.libraryId}
        ORDER BY i.index_number ASC, i.sort_title ASC, i.id ASC
        LIMIT ${pagination.limit + 1} OFFSET ${offset}
      `));
      return unknownJson({ items: rows.slice(0, pagination.limit), nextCursor: rows.length > pagination.limit ? encodeCursor(offset + pagination.limit) : null });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "next-up") {
      const show = await call(services.database.get<{ libraryId: string; kind: string }>(sql`SELECT library_id AS libraryId, kind FROM catalog_items WHERE id = ${parts[3]}`));
      if (show == null || show.kind !== "show") throw notFound("Series not found");
      await call(services.access.requireLibrary(principal, show.libraryId, "library:read", Date.now()));
      const episode = await call(services.database.get(sql`
        SELECT e.id, e.library_id AS libraryId, e.parent_id AS parentId, e.title, e.kind,
          e.index_number AS indexNumber, e.duration_seconds * 1000 AS durationMs, e.year,
          (SELECT a.artwork_id FROM catalog_item_artwork a WHERE a.item_id = e.id AND a.role = 'still') AS artworkId,
          w.position_seconds AS resumePositionSeconds
        FROM catalog_items e LEFT JOIN catalog_items season ON season.id = e.parent_id
        LEFT JOIN item_watch_states w ON w.item_id = e.id AND w.user_id = ${principal.user.id}
        WHERE (season.parent_id = ${parts[3]} OR e.parent_id = ${parts[3]})
          AND e.kind = 'episode' AND COALESCE(w.completed, 0) = 0
        ORDER BY COALESCE(season.index_number, 0) ASC, e.index_number ASC, e.sort_title ASC, e.id ASC LIMIT 1
      `));
      return unknownJson({ item: episode });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined) {
      const item = await call(services.database.get<{ id: string; libraryId: string; title: string; kind: string; year: number | null; overview: string | null; durationSeconds: number | null }>(sql`
        SELECT i.id, i.library_id AS libraryId, i.parent_id AS parentId, i.title, i.kind, i.year,
          i.index_number AS indexNumber, i.overview, i.duration_seconds AS durationSeconds,
          m.release_date AS releaseDate, m.content_rating AS contentRating, m.community_rating AS communityRating,
          COALESCE(m.genres_json, '[]') AS genresJson, COALESCE(m.studios_json, '[]') AS studiosJson,
          COALESCE(m.tags_json, '[]') AS tagsJson, COALESCE(m.external_ids_json, '{}') AS externalIdsJson,
          (SELECT a.artwork_id FROM catalog_item_artwork a WHERE a.item_id = i.id AND a.role = 'poster') AS artworkId,
          (SELECT a.artwork_id FROM catalog_item_artwork a WHERE a.item_id = i.id AND a.role = 'backdrop') AS backdropId
        FROM catalog_items i LEFT JOIN catalog_item_metadata m ON m.item_id = i.id WHERE i.id = ${parts[3]}
      `));
      if (item == null) throw notFound("Item not found");
      await call(services.access.requireLibrary(principal, item.libraryId, "library:read", Date.now()));
      const sources = await call(services.database.all<{ id: string; generation: number; available: number; size: number | null; modifiedAtMs: number | null }>(sql`
        SELECT s.id, cs.source_generation AS generation, COALESCE(a.is_available, 1) AS available, s.file_size_bytes AS size, s.modified_at_ms AS modifiedAtMs
        FROM catalog_item_sources cs JOIN media_sources s ON s.id = cs.source_id
        LEFT JOIN media_source_availability a ON a.source_id = s.id
        WHERE cs.item_id = ${item.id} ORDER BY cs.is_primary DESC, s.id
      `));
      const watchState = await call(services.database.get<{ positionSeconds: number; completed: number }>(sql`
        SELECT position_seconds AS positionSeconds, completed FROM item_watch_states WHERE user_id = ${principal.user.id} AND item_id = ${item.id}
      `));
      const favorite = await call(services.database.get<{ itemId: string }>(sql`SELECT item_id AS itemId FROM item_favorites WHERE user_id = ${principal.user.id} AND item_id = ${item.id}`));
      return unknownJson({ item, sources: sources.map((source) => ({ ...source, available: source.available === 1 })), watchState: watchState == null ? null : { ...watchState, completed: watchState.completed === 1 }, isFavorite: favorite != null, metadataProviderConfigured: (await call(services.metadataSettings.tmdbKey())) !== null });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "tracks") return unknownJson(await call(services.catalog.listTracks(principal, url.searchParams.get("libraryId"), page(url), Date.now())));
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "favorite") {
      const input = decode(S.FavoriteBody, await body(request, config.maxRequestBodyBytes));
      const item = await call(services.database.get<{ libraryId: string }>(sql`SELECT library_id AS libraryId FROM catalog_items WHERE id = ${parts[3]}`));
      if (item == null) throw notFound("Item not found");
      await call(services.access.requireLibrary(principal, item.libraryId, "favorites:write", Date.now()));
      if (input.isFavorite) {
        await call(services.database.run(sql`INSERT INTO item_favorites(user_id, item_id, created_at_ms) VALUES (${principal.user.id}, ${parts[3]}, unixepoch() * 1000) ON CONFLICT(user_id, item_id) DO NOTHING`));
      } else {
        await call(services.database.run(sql`DELETE FROM item_favorites WHERE user_id = ${principal.user.id} AND item_id = ${parts[3]}`));
      }
      return ack();
    }
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "items" && parts[3] !== undefined && parts[4] === "watch-state") {
      const input = decode(S.ItemWatchStateBody, await body(request, config.maxRequestBodyBytes));
      const item = await call(services.database.get<{ libraryId: string }>(sql`SELECT library_id AS libraryId FROM catalog_items WHERE id = ${parts[3]}`));
      if (item == null) throw notFound("Item not found");
      await call(services.access.requireLibrary(principal, item.libraryId, "library:read", Date.now()));
      await call(services.database.run(sql`
        INSERT INTO item_watch_states(user_id, item_id, position_seconds, completed, ownership_generation, manual_version, updated_at_ms)
        VALUES (${principal.user.id}, ${parts[3]}, ${input.positionSeconds}, ${input.completed ? 1 : 0}, 1, 1, unixepoch() * 1000)
        ON CONFLICT(user_id, item_id) DO UPDATE SET position_seconds = excluded.position_seconds, completed = excluded.completed, manual_version = item_watch_states.manual_version + 1, updated_at_ms = excluded.updated_at_ms
      `));
      return ack();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "search") {
      const input = decode(S.SearchQuery, { q: url.searchParams.get("q"), libraryId: url.searchParams.get("libraryId"), limit: queryNumber(url, "limit", 25), cursor: url.searchParams.get("cursor") });
      const offset = decodeCursor(input.cursor);
      if (input.libraryId !== null) await call(services.access.requireLibrary(principal, input.libraryId, "library:read", Date.now()));
      const libraryIds = input.libraryId === null ? await call(services.access.accessibleLibraryIds(principal, Date.now())) : [input.libraryId];
      if (libraryIds.length === 0) return unknownJson({ items: [], nextCursor: null });
      const placeholders = libraryIds.map((id) => sql`${id}`);
      const match = input.q.trim().split(/\s+/u).map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
      const itemRows = await call(services.database.all<{ id: string; libraryId: string; title: string; kind: string; durationMs: number | null; year: number | null }>(sql`
        SELECT i.id, i.library_id AS libraryId, i.title, i.kind, i.duration_seconds * 1000 AS durationMs, i.year
        FROM catalog_item_fts f JOIN catalog_items i ON i.id = f.item_id
        WHERE catalog_item_fts MATCH ${match} AND i.library_id IN (${sql.join(placeholders, sql`, `)})
        ORDER BY bm25(catalog_item_fts), i.sort_title, i.id LIMIT ${input.limit + 1} OFFSET ${offset}
      `));
      if (itemRows.length > 0) {
        const hasMore = itemRows.length > input.limit;
        const items = itemRows.slice(0, input.limit).map((item) => ({ ...item, artworkId: null, resumePositionSeconds: null }));
        return unknownJson({ items, nextCursor: hasMore ? encodeCursor(offset + input.limit) : null });
      }
      return unknownJson(await call(services.catalog.search(principal, input, Date.now())));
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "tracks" && parts[3] !== undefined) return unknownJson(await call(services.catalog.trackDetails(principal, parts[3], Date.now())));
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "tracks" && parts[3] !== undefined && parts[4] === "favorite") { await call(services.catalog.setFavorite(principal, parts[3], decode(S.FavoriteBody, await body(request, config.maxRequestBodyBytes)), Date.now())); return ack(); }
    if (method === "PUT" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "tracks" && parts[3] !== undefined && parts[4] === "watch-state") return unknownJson(await call(services.catalog.setWatchState(principal, parts[3], decode(S.WatchStateBody, await body(request, config.maxRequestBodyBytes)), Date.now())));
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "playback" && parts[3] === "sessions") {
      const input = decode(S.StartPlaybackBody, await body(request, config.maxRequestBodyBytes));
      const result = await call(services.playback.start(principal, input, Date.now()));
      return unknownJson({
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
      }, 201);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "playback" && parts[3] === "sessions" && parts[4] !== undefined && parts[5] === "heartbeat") return unknownJson(await call(services.playback.heartbeat(principal, parts[4], decode(S.HeartbeatBody, await body(request, config.maxRequestBodyBytes)), Date.now())));
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "playback" && parts[3] === "sessions" && parts[4] !== undefined) { await call(services.playback.stop(principal, parts[4], Date.now())); return ack(); }
    if (method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "playback" && parts[3] === "sessions" && parts[4] !== undefined && parts[5] === "progress") return unknownJson(await call(services.playback.progress(principal, parts[4], decode(S.ProgressBody, await body(request, config.maxRequestBodyBytes)), Date.now())));

    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "events") {
      const after = queryNumber(url, "after", 0);
      return new Response(services.events.stream(after, principal.user.id, request.signal), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "artwork" && parts[3] !== undefined) {
      const asset = await call(services.assets.artwork(principal, parts[3], Date.now()));
      return serveFile({ request, path: asset.path, size: asset.size, modifiedAtMs: asset.modifiedAtMs, mimeType: asset.mimeType });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "sidecars" && parts[3] !== undefined) {
      const asset = await call(services.assets.sidecar(principal, parts[3], Date.now()));
      return serveFile({ request, path: asset.path, size: asset.size, modifiedAtMs: asset.modifiedAtMs, mimeType: asset.mimeType });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "library-roots" && parts[3] !== undefined) { await call(services.access.requireAdmin(principal)); return unknownJson(await call(services.libraries.listRoots(parts[3]))); }
    throw notFound("Endpoint not found");
  };
  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) ?? newUuid();
    const key = clientKey(request);
    const login = new URL(request.url).pathname.endsWith("/auth/login") || new URL(request.url).pathname.endsWith("/auth/register");
    try {
      const execute = Effect.tryPromise({ try: () => dispatch(request), catch: (cause) => cause });
      const checked = limiter.check(key, Date.now(), login ? "login" : "request");
      return await Effect.runPromise(checked.pipe(Effect.flatMap(() => limiter.run(key, execute))));
    } catch (cause) {
      return errorResponse(cause, requestId);
    }
  };
};
