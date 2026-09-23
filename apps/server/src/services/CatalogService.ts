import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer, Schema } from "effect";
import { badRequest, forbidden, notFound } from "../core/Errors";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import { FavoriteBody, PaginationQuery, SearchQuery, WatchStateBody } from "../http/Schemas";

type WatchInput = Schema.Schema.Type<typeof WatchStateBody>;
type FavoriteInput = Schema.Schema.Type<typeof FavoriteBody>;
type PaginationInput = Schema.Schema.Type<typeof PaginationQuery>;
type SearchInput = Schema.Schema.Type<typeof SearchQuery>;

const encodeCursor = (offset: number): string => Buffer.from(String(offset), "utf8").toString("base64url");
const decodeCursor = (cursor: string | null | undefined): number => {
  if (cursor == null || cursor === undefined || cursor === "") return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
};

export interface CatalogServiceShape {
  readonly listTracks: (principal: AuthPrincipal, libraryId: string | null, input: PaginationInput, nowMs: number) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly search: (principal: AuthPrincipal, input: SearchInput, nowMs: number) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly trackDetails: (principal: AuthPrincipal, trackId: string, nowMs: number) => Effect.Effect<unknown, unknown>;
  readonly setFavorite: (principal: AuthPrincipal, trackId: string, input: FavoriteInput, nowMs: number) => Effect.Effect<void, unknown>;
  readonly setWatchState: (principal: AuthPrincipal, trackId: string, input: WatchInput, nowMs: number) => Effect.Effect<unknown, unknown>;
}

export const makeCatalogService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;
  const listTracks: CatalogServiceShape["listTracks"] = Effect.fn("Catalog.listTracks")(function* (principal, libraryId, input, nowMs) {
    const offset = decodeCursor(input.cursor);
    if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
    const libraryIds = libraryId == null ? yield* access.accessibleLibraryIds(principal, nowMs) : [libraryId];
    if (libraryId !== null) yield* access.requireLibrary(principal, libraryId, "library:read", nowMs);
    if (libraryIds.length === 0) return { items: [], nextCursor: null };
    const placeholders = libraryIds.map((id) => sql`${id}`);
    const rows = yield* database.all<{
      id: string; libraryId: string; title: string; normalizedTitle: string; durationMs: number | null; albumId: string | null; trackNumber: number | null; discNumber: number | null;
    }>(sql`
      SELECT id, library_id AS libraryId, title, normalized_title AS normalizedTitle, duration_ms AS durationMs,
        album_id AS albumId, track_number AS trackNumber, disc_number AS discNumber
      FROM tracks WHERE library_id IN (${sql.join(placeholders, sql`, `)})
      ORDER BY created_at_ms ASC, id ASC LIMIT ${input.limit + 1} OFFSET ${offset}
    `);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit);
    return { items, nextCursor: hasMore ? encodeCursor(offset + input.limit) : null };
  });

  const search: CatalogServiceShape["search"] = Effect.fn("Catalog.search")(function* (principal, input, nowMs) {
    const offset = decodeCursor(input.cursor);
    if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
    const ids = yield* access.accessibleLibraryIds(principal, nowMs);
    if (input.libraryId !== null) yield* access.requireLibrary(principal, input.libraryId, "library:read", nowMs);
    if (ids.length === 0) return { items: [], nextCursor: null };
    const libraryPlaceholders = ids.map((id) => sql`${id}`);
    const match = input.q.trim().split(/\s+/u).map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
    const rows = yield* database.all<{ entityType: "artist" | "album" | "track"; entityId: string; title: string; subtitle: string | null; rank: number }>(sql`
      SELECT f.entity_type AS entityType, f.entity_id AS entityId, f.title, nullif(f.subtitle, '') AS subtitle, bm25(catalog_fts) AS rank
      FROM catalog_fts f
      WHERE catalog_fts MATCH ${match}
        AND (
          (f.entity_type = 'artist' AND EXISTS (SELECT 1 FROM artists a WHERE a.id = f.entity_id AND a.library_id IN (${sql.join(libraryPlaceholders, sql`, `)})))
          OR (f.entity_type = 'album' AND EXISTS (SELECT 1 FROM albums a WHERE a.id = f.entity_id AND a.library_id IN (${sql.join(libraryPlaceholders, sql`, `)})))
          OR (f.entity_type = 'track' AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = f.entity_id AND t.library_id IN (${sql.join(libraryPlaceholders, sql`, `)})))
        )
      ORDER BY rank, f.entity_type, f.entity_id LIMIT ${input.limit + 1} OFFSET ${offset}
    `);
    const hasMore = rows.length > input.limit;
    return { items: rows.slice(0, input.limit), nextCursor: hasMore ? encodeCursor(offset + input.limit) : null };
  });

  const trackDetails: CatalogServiceShape["trackDetails"] = Effect.fn("Catalog.trackDetails")(function* (principal, trackId, nowMs) {
    yield* access.requireTrack(principal, trackId, "library:read", nowMs);
    const trackRow = yield* database.get<{
      id: string;
      libraryId: string;
      sourceId: string;
      primaryStreamId: string;
      albumId: string | null;
      title: string;
      normalizedTitle: string;
      trackNumber: number | null;
      discNumber: number | null;
      durationMs: number | null;
      isExplicit: number;
      createdAtMs: number;
      updatedAtMs: number;
    }>(sql`
      SELECT id, library_id AS libraryId, source_id AS sourceId, primary_stream_id AS primaryStreamId, album_id AS albumId,
        title, normalized_title AS normalizedTitle, track_number AS trackNumber, disc_number AS discNumber,
        duration_ms AS durationMs, is_explicit AS isExplicit, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      FROM tracks WHERE id = ${trackId}
    `);
    if (trackRow == null) return yield* notFound("Track not found");
    const track = { ...trackRow, isExplicit: trackRow.isExplicit === 1 };
    const chapters = yield* repositories.catalog.listChapters({ streamId: track.primaryStreamId }).pipe(Effect.mapError(() => []));
    const metadata = yield* repositories.catalog.listMetadata({ trackId }).pipe(Effect.mapError(() => []));
    const artwork = yield* database.all(sql`
      SELECT a.id, a.mime_type AS mimeType, a.width, a.height, a.relative_path AS relativePath
      FROM artwork a JOIN artwork_assignments aa ON aa.artwork_id = a.id
      WHERE aa.track_id = ${trackId} AND aa.is_primary = 1 LIMIT 1
    `);
    return { track, chapters, metadata, artwork };
  });

  const setFavorite: CatalogServiceShape["setFavorite"] = Effect.fn("Catalog.setFavorite")(function* (principal, trackId, input, nowMs) {
    yield* access.requireTrack(principal, trackId, "favorites:write", nowMs);
    yield* repositories.activity.setFavorite({ userId: principal.user.id, trackId, isFavorite: input.isFavorite, nowMs }).pipe(Effect.mapError(() => forbidden("Favorite could not be updated")));
  });

  const setWatchState: CatalogServiceShape["setWatchState"] = Effect.fn("Catalog.setWatchState")(function* (principal, trackId, input, nowMs) {
    yield* access.requireTrack(principal, trackId, "library:read", nowMs);
    return yield* repositories.activity.upsertWatchState({ id: crypto.randomUUID(), userId: principal.user.id, trackId, positionMs: input.positionMs, completed: input.completed, nowMs }).pipe(Effect.mapError(() => forbidden("Watch state could not be updated")));
  });
  return { listTracks, search, trackDetails, setFavorite, setWatchState };
});

export class CatalogService extends Context.Service<CatalogService, CatalogServiceShape>()("@lumen/server/Catalog") {}
export const CatalogServiceLive = Layer.effect(CatalogService, makeCatalogService);
