import { extname } from "node:path";
import type { Database } from "@lumen/database";
import { type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { AccessControlShape } from "../services/AccessControl";
import type { AuthPrincipal } from "../services/AuthService";

export type Kind = "movie" | "show" | "season" | "episode";
export const VIDEO_KINDS: ReadonlyArray<Kind> = ["movie", "show", "season", "episode"];

export interface View {
  readonly id: string;
  readonly name: string;
  readonly kind: "movies" | "shows";
  readonly childCount: number;
}

export interface ItemRow {
  readonly id: string;
  readonly libraryId: string;
  readonly parentId: string | null;
  readonly kind: Kind;
  readonly title: string;
  readonly sortName: string;
  readonly originalTitle: string | null;
  readonly overview: string | null;
  readonly year: number | null;
  readonly indexNumber: number | null;
  readonly indexNumberEnd: number | null;
  readonly durationSeconds: number | null;
  readonly addedAtMs: number;
  readonly releaseDate: string | null;
  readonly contentRating: string | null;
  readonly communityRating: number | null;
  readonly genresJson: string;
  readonly externalIdsJson: string;
  readonly primaryTag: string | null;
  readonly backdropTag: string | null;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  readonly seriesPrimaryTag: string | null;
  readonly seriesBackdropTag: string | null;
  readonly seasonId: string | null;
  readonly seasonTitle: string | null;
  readonly seasonNumber: number | null;
  readonly positionSeconds: number;
  readonly completed: number;
  readonly played: number;
  readonly playedAtMs: number | null;
  readonly isFavorite: number;
  readonly childCount: number | null;
  readonly episodeCount: number | null;
  readonly unplayedCount: number | null;
}

export interface StreamRow {
  readonly id: string;
  readonly kind: "video" | "audio" | "subtitle";
  readonly ordinal: number;
  readonly codec: string | null;
  readonly language: string | null;
  readonly title: string | null;
  readonly isDefault: number;
  readonly forced: number | null;
  readonly hearingImpaired: number | null;
  readonly channels: number | null;
  readonly bitrate: number | null;
  readonly sampleRateHz: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface SourceRow {
  readonly sourceId: string;
  readonly container: string | null;
  readonly size: number | null;
  readonly modifiedAtMs: number | null;
  readonly durationSeconds: number | null;
  readonly streams: ReadonlyArray<StreamRow>;
}

export type SortBy = "SortName" | "DateCreated" | "PremiereDate" | "DatePlayed" | "Latest";

export interface ItemQuery {
  /** A library or an item; descendants with `recursive`, children without. */
  readonly parentId: string | null;
  readonly recursive: boolean;
  readonly kinds: ReadonlyArray<Kind>;
  readonly ids: ReadonlyArray<string> | null;
  readonly search: string | null;
  readonly favorite: boolean | null;
  readonly played: boolean | null;
  readonly resumable: boolean;
  readonly seasonNumber?: number | null;
  readonly sortBy: SortBy;
  readonly descending: boolean;
  readonly startIndex: number;
  readonly limit: number | null;
}

export const ALL_ITEMS: ItemQuery = {
  parentId: null,
  recursive: true,
  kinds: VIDEO_KINDS,
  ids: null,
  search: null,
  favorite: null,
  played: null,
  resumable: false,
  sortBy: "SortName",
  descending: false,
  startIndex: 0,
  limit: null,
};

const list = (values: ReadonlyArray<string>) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

const artwork = (item: SQL, roles: ReadonlyArray<string>) => sql`(
  SELECT art.content_hash FROM catalog_item_artwork a JOIN artwork art ON art.id = a.artwork_id
  WHERE a.item_id = ${item} AND a.role IN (${list(roles)})
  ORDER BY CASE a.role ${sql.join(
    roles.map((role, index) => sql`WHEN ${role} THEN ${index}`),
    sql` `,
  )} END LIMIT 1
)`;

// Episodes of a show sit in its seasons or directly under it.
const episodesOf = (item: SQL) => sql`
  FROM catalog_items e WHERE e.kind = 'episode' AND (e.parent_id = ${item}
    OR e.parent_id IN (SELECT s.id FROM catalog_items s WHERE s.parent_id = ${item} AND s.kind = 'season'))`;

/** Every video item in the viewer's libraries, with what a Jellyfin item needs to show it. */
const itemsTable = (userId: string, libraryIds: ReadonlyArray<string>) => sql`
  SELECT i.id, i.library_id AS libraryId, i.parent_id AS parentId, i.kind, i.title,
    CASE i.kind
      WHEN 'episode' THEN printf('%05d %05d ', CASE WHEN p.kind = 'season' THEN coalesce(p.index_number, 0) ELSE 0 END, coalesce(i.index_number, 0)) || i.sort_title
      WHEN 'season' THEN printf('%05d ', coalesce(i.index_number, 0)) || i.sort_title
      ELSE i.sort_title END AS sortName,
    i.original_title AS originalTitle, i.overview, i.year, i.index_number AS indexNumber,
    i.index_number_end AS indexNumberEnd, i.duration_seconds AS durationSeconds,
    i.added_at_ms AS addedAtMs, m.release_date AS releaseDate, m.content_rating AS contentRating,
    m.community_rating AS communityRating, coalesce(m.genres_json, '[]') AS genresJson,
    coalesce(m.external_ids_json, '{}') AS externalIdsJson,
    ${artwork(sql`i.id`, ["poster", "still"])} AS primaryTag,
    ${artwork(sql`i.id`, ["backdrop"])} AS backdropTag,
    CASE WHEN p.kind = 'show' THEN p.id WHEN p.kind = 'season' THEN g.id END AS seriesId,
    CASE WHEN p.kind = 'show' THEN p.title WHEN p.kind = 'season' THEN g.title END AS seriesTitle,
    CASE WHEN p.kind = 'season' THEN p.id END AS seasonId,
    CASE WHEN p.kind = 'season' THEN p.title END AS seasonTitle,
    CASE WHEN p.kind = 'season' THEN p.index_number END AS seasonNumber,
    coalesce(w.position_seconds, 0) AS positionSeconds, coalesce(w.completed, 0) AS completed,
    w.updated_at_ms AS playedAtMs,
    EXISTS (SELECT 1 FROM item_favorites f WHERE f.user_id = ${userId} AND f.item_id = i.id) AS isFavorite,
    CASE WHEN i.kind IN ('show', 'season')
      THEN (SELECT count(*) FROM catalog_items c WHERE c.parent_id = i.id) END AS childCount,
    CASE WHEN i.kind IN ('show', 'season')
      THEN (SELECT count(*) ${episodesOf(sql`i.id`)}) END AS episodeCount,
    CASE WHEN i.kind IN ('show', 'season')
      THEN (SELECT count(*) ${episodesOf(sql`i.id`)} AND NOT EXISTS (SELECT 1 FROM item_watch_states x
        WHERE x.item_id = e.id AND x.user_id = ${userId} AND x.completed = 1)) END AS unplayedCount,
    CASE WHEN i.kind IN ('show', 'season')
      THEN coalesce((SELECT max(e.added_at_ms) ${episodesOf(sql`i.id`)}), i.added_at_ms)
      ELSE i.added_at_ms END AS latestAtMs
  FROM catalog_items i
  LEFT JOIN catalog_item_metadata m ON m.item_id = i.id
  LEFT JOIN item_watch_states w ON w.item_id = i.id AND w.user_id = ${userId}
  LEFT JOIN catalog_items p ON p.id = i.parent_id AND p.library_id = i.library_id
  LEFT JOIN catalog_items g ON g.id = p.parent_id AND g.library_id = i.library_id AND g.kind = 'show'
  WHERE i.library_id IN (${list(libraryIds)}) AND i.kind IN ('movie', 'show', 'season', 'episode')
`;

const withSeries = (table: SQL) => sql`
  WITH base AS (${table}), items AS (
    SELECT base.*,
      CASE WHEN kind IN ('show', 'season') THEN episodeCount > 0 AND unplayedCount = 0
        ELSE completed END AS played,
      ${artwork(sql`base.seriesId`, ["poster"])} AS seriesPrimaryTag,
      ${artwork(sql`base.seriesId`, ["backdrop"])} AS seriesBackdropTag
    FROM base
  )`;

const order: Record<SortBy, SQL> = {
  SortName: sql`sortName`,
  DateCreated: sql`addedAtMs`,
  PremiereDate: sql`coalesce(releaseDate, CAST(year AS TEXT))`,
  DatePlayed: sql`playedAtMs`,
  Latest: sql`latestAtMs`,
};

const escapeLike = (value: string) => value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);

export const makeQueries = (database: Database["Service"], access: AccessControlShape) => {
  const views = Effect.fn("Jellyfin.views")(function* (principal: AuthPrincipal, nowMs: number) {
    const ids = yield* access.accessibleLibraryIds(principal, nowMs);
    if (ids.length === 0) return [];
    return yield* database.all<View>(sql`
      SELECT l.id, l.name, coalesce(p.kind, 'movies') AS kind,
        (SELECT count(*) FROM catalog_items i WHERE i.library_id = l.id AND i.parent_id IS NULL) AS childCount
      FROM libraries l LEFT JOIN library_profiles p ON p.library_id = l.id
      WHERE l.id IN (${list(ids)}) AND coalesce(p.kind, 'movies') IN ('movies', 'shows')
      ORDER BY l.name, l.id
    `);
  });

  const items = Effect.fn("Jellyfin.items")(function* (
    principal: AuthPrincipal,
    query: ItemQuery,
    nowMs: number,
  ) {
    const libraries = yield* views(principal, nowMs);
    if (libraries.length === 0 || query.kinds.length === 0 || query.ids?.length === 0)
      return { rows: [] as ReadonlyArray<ItemRow>, total: 0 };
    const conditions: SQL[] = [sql`kind IN (${list(query.kinds)})`];
    if (query.parentId !== null) {
      const isLibrary = libraries.some((library) => library.id === query.parentId);
      if (isLibrary)
        conditions.push(
          query.recursive
            ? sql`libraryId = ${query.parentId}`
            : sql`libraryId = ${query.parentId} AND parentId IS NULL`,
        );
      else
        conditions.push(
          query.recursive
            ? sql`(parentId = ${query.parentId} OR parentId IN
                (SELECT c.id FROM catalog_items c WHERE c.parent_id = ${query.parentId}))`
            : sql`parentId = ${query.parentId}`,
        );
    } else if (!query.recursive) conditions.push(sql`parentId IS NULL`);
    if (query.ids !== null) conditions.push(sql`id IN (${list(query.ids)})`);
    if (query.search !== null)
      conditions.push(sql`title LIKE ${`%${escapeLike(query.search)}%`} ESCAPE '\\'`);
    if (query.favorite !== null) conditions.push(sql`isFavorite = ${query.favorite ? 1 : 0}`);
    if (query.played !== null) conditions.push(sql`played = ${query.played ? 1 : 0}`);
    if (query.resumable) conditions.push(sql`completed = 0 AND positionSeconds > 0`);
    if (query.seasonNumber != null) conditions.push(sql`seasonNumber = ${query.seasonNumber}`);
    const from = sql`${withSeries(
      itemsTable(
        principal.user.id,
        libraries.map((library) => library.id),
      ),
    )} SELECT * FROM items WHERE ${sql.join(conditions, sql` AND `)}`;
    const direction = sql.raw(query.descending ? "DESC" : "ASC");
    const rows = yield* database.all<ItemRow>(sql`${from}
      ORDER BY ${order[query.sortBy]} ${direction}, sortName ${direction}, id
      LIMIT ${query.limit ?? -1} OFFSET ${query.startIndex}`);
    const counted =
      query.limit === null || (query.startIndex === 0 && rows.length < query.limit)
        ? null
        : yield* database.get<{ total: number }>(sql`SELECT count(*) AS total FROM (${from})`);
    return { rows, total: counted?.total ?? query.startIndex + rows.length };
  });

  const item = Effect.fn("Jellyfin.item")(function* (
    principal: AuthPrincipal,
    id: string,
    nowMs: number,
  ) {
    const { rows } = yield* items(principal, { ...ALL_ITEMS, ids: [id] }, nowMs);
    return rows[0] ?? null;
  });

  /** The file an item plays and its streams. Callers check access to the item first. */
  const source = Effect.fn("Jellyfin.source")(function* (itemId: string, sourceId?: string) {
    const row = yield* database.get<{
      sourceId: string;
      absolutePath: string;
      size: number | null;
      modifiedAtMs: number | null;
      durationSeconds: number | null;
    }>(sql`
      SELECT ms.id AS sourceId, ms.absolute_path AS absolutePath, ms.file_size_bytes AS size,
        ms.modified_at_ms AS modifiedAtMs, i.duration_seconds AS durationSeconds
      FROM catalog_item_sources cs
      JOIN catalog_items i ON i.id = cs.item_id
      JOIN media_sources ms ON ms.id = cs.source_id
      JOIN tracks t ON t.source_id = ms.id
      WHERE cs.item_id = ${itemId} ${sourceId === undefined ? sql`` : sql`AND ms.id = ${sourceId}`}
      ORDER BY cs.is_primary DESC, ms.id LIMIT 1
    `);
    if (row === undefined) return null;
    const streams = yield* database.all<StreamRow>(sql`
      SELECT id, kind, ordinal, codec, language, title, is_default AS isDefault, forced,
        hearing_impaired AS hearingImpaired, channels, bitrate, sample_rate_hz AS sampleRateHz,
        width, height
      FROM streams WHERE source_id = ${row.sourceId} AND ordinal IS NOT NULL ORDER BY ordinal
    `);
    const extension = extname(row.absolutePath).slice(1).toLowerCase();
    return {
      sourceId: row.sourceId,
      container: extension === "" ? null : extension,
      size: row.size,
      modifiedAtMs: row.modifiedAtMs,
      durationSeconds: row.durationSeconds,
      streams,
    } satisfies SourceRow;
  });

  /** An item's image in the first role it has. Callers authorize the artwork itself. */
  const artworkOf = (itemId: string, roles: ReadonlyArray<string>) =>
    database.get<{ id: string; contentHash: string }>(sql`
      SELECT art.id, art.content_hash AS contentHash
      FROM catalog_item_artwork a JOIN artwork art ON art.id = a.artwork_id
      WHERE a.item_id = ${itemId} AND a.role IN (${list(roles)})
      ORDER BY CASE a.role ${sql.join(
        roles.map((role, index) => sql`WHEN ${role} THEN ${index}`),
        sql` `,
      )} END LIMIT 1
    `);

  return { views, items, item, source, artworkOf };
};

export type Queries = ReturnType<typeof makeQueries>;
