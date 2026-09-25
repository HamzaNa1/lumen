import {
  albums,
  artists,
  artwork,
  artworkAssignments,
  buildFtsMatch,
  catalogItemArtwork,
  catalogItemFts,
  catalogItemMetadata,
  catalogItems,
  catalogItemSources,
  catalogFts,
  Database,
  itemFavorites,
  itemWatchStates,
  mediaSourceAvailability,
  mediaSources,
  providerRecords,
  Repositories,
  tracks,
} from "@lumen/database";
import { and, asc, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Context, Effect, Layer, type Schema } from "effect";
import { badRequest, forbidden, notFound } from "../core/Errors";
import { AccessControl } from "./AccessControl";
import { decodeMetadataList, decodeMetadataMap } from "../media/MetadataJson";
import type { AuthPrincipal } from "./AuthService";
import type {
  FavoriteBody,
  ItemMatchBody,
  ItemMetadataBody,
  ItemWatchStateBody,
  PaginationQuery,
  SearchQuery,
  WatchStateBody,
} from "../http/Schemas";

type WatchInput = Schema.Schema.Type<typeof WatchStateBody>;
type FavoriteInput = Schema.Schema.Type<typeof FavoriteBody>;
type PaginationInput = Schema.Schema.Type<typeof PaginationQuery>;
type SearchInput = Schema.Schema.Type<typeof SearchQuery>;
type ItemMetadataInput = Schema.Schema.Type<typeof ItemMetadataBody>;
type ItemMatchInput = Schema.Schema.Type<typeof ItemMatchBody>;
type ItemWatchInput = Schema.Schema.Type<typeof ItemWatchStateBody>;

const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset), "utf8").toString("base64url");
const decodeCursor = (cursor: string | null | undefined): number => {
  if (cursor == null || cursor === undefined || cursor === "") return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
};

export interface CatalogServiceShape {
  readonly listItems: (
    principal: AuthPrincipal,
    libraryId: string | null,
    input: PaginationInput,
    nowMs: number,
  ) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly updateItemMetadata: (
    itemId: string,
    input: ItemMetadataInput,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly matchItem: (itemId: string, input: ItemMatchInput) => Effect.Effect<void, unknown>;
  readonly listItemChildren: (
    principal: AuthPrincipal,
    itemId: string,
    input: PaginationInput,
    nowMs: number,
  ) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly nextUp: (
    principal: AuthPrincipal,
    itemId: string,
    nowMs: number,
  ) => Effect.Effect<{ item: unknown }, unknown>;
  readonly itemDetails: (
    principal: AuthPrincipal,
    itemId: string,
    metadataProviderConfigured: boolean,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
  readonly setItemFavorite: (
    principal: AuthPrincipal,
    itemId: string,
    input: FavoriteInput,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly setItemWatchState: (
    principal: AuthPrincipal,
    itemId: string,
    input: ItemWatchInput,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly searchItems: (
    principal: AuthPrincipal,
    input: SearchInput,
    nowMs: number,
  ) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly listTracks: (
    principal: AuthPrincipal,
    libraryId: string | null,
    input: PaginationInput,
    nowMs: number,
  ) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly search: (
    principal: AuthPrincipal,
    input: SearchInput,
    nowMs: number,
  ) => Effect.Effect<{ items: ReadonlyArray<unknown>; nextCursor: string | null }, unknown>;
  readonly trackDetails: (
    principal: AuthPrincipal,
    trackId: string,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
  readonly setFavorite: (
    principal: AuthPrincipal,
    trackId: string,
    input: FavoriteInput,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly setWatchState: (
    principal: AuthPrincipal,
    trackId: string,
    input: WatchInput,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
}

export const makeCatalogService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;

  const listItems: CatalogServiceShape["listItems"] = Effect.fn("Catalog.listItems")(
    function* (principal, libraryId, input, nowMs) {
      const offset = decodeCursor(input.cursor);
      if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
      if (libraryId !== null)
        yield* access.requireLibrary(principal, libraryId, "library:read", nowMs);
      const libraryIds =
        libraryId === null ? yield* access.accessibleLibraryIds(principal, nowMs) : [libraryId];
      if (libraryIds.length === 0) return { items: [], nextCursor: null };
      const rows = yield* database
        .select({
          id: catalogItems.id,
          libraryId: catalogItems.libraryId,
          title: catalogItems.title,
          kind: catalogItems.kind,
          durationMs: sql<number | null>`${catalogItems.durationSeconds} * 1000`,
          year: catalogItems.year,
          artworkId: sql<string | null>`(
            select ${catalogItemArtwork.artworkId} from ${catalogItemArtwork}
            where ${catalogItemArtwork.itemId} = ${catalogItems.id}
              and ${catalogItemArtwork.role} = 'poster'
          )`,
          resumePositionSeconds: itemWatchStates.positionSeconds,
        })
        .from(catalogItems)
        .leftJoin(
          itemWatchStates,
          and(
            eq(itemWatchStates.itemId, catalogItems.id),
            eq(itemWatchStates.userId, principal.user.id),
          ),
        )
        .where(and(inArray(catalogItems.libraryId, libraryIds), isNull(catalogItems.parentId)))
        .orderBy(asc(catalogItems.sortTitle), asc(catalogItems.id))
        .limit(input.limit + 1)
        .offset(offset);
      return {
        items: rows.slice(0, input.limit),
        nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
      };
    },
  );

  const updateItemMetadata: CatalogServiceShape["updateItemMetadata"] = Effect.fn(
    "Catalog.updateItemMetadata",
  )(function* (itemId, input, nowMs) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const old = yield* transaction
          .select({
            title: catalogItems.title,
            overview: catalogItems.overview,
            year: catalogItems.year,
            releaseDate: catalogItemMetadata.releaseDate,
            contentRating: catalogItemMetadata.contentRating,
            communityRating: catalogItemMetadata.communityRating,
            genresJson: catalogItemMetadata.genresJson,
            studiosJson: catalogItemMetadata.studiosJson,
            tagsJson: catalogItemMetadata.tagsJson,
            externalIdsJson: catalogItemMetadata.externalIdsJson,
            fieldSourcesJson: catalogItemMetadata.fieldSourcesJson,
            lockedFieldsJson: catalogItemMetadata.lockedFieldsJson,
          })
          .from(catalogItems)
          .leftJoin(catalogItemMetadata, eq(catalogItemMetadata.itemId, catalogItems.id))
          .where(eq(catalogItems.id, itemId))
          .get();
        if (old == null) return yield* notFound("Item not found");
        const locks = new Set(decodeMetadataList(old.lockedFieldsJson));
        const fieldSources = decodeMetadataMap(old.fieldSourcesJson);
        for (const key of Object.keys(input)) {
          locks.add(key);
          fieldSources[key] = "user";
        }
        const title = input.title ?? old.title;
        yield* transaction
          .update(catalogItems)
          .set({
            title,
            sortTitle: title.toLowerCase(),
            overview: input.overview === undefined ? old.overview : input.overview,
            year: input.year === undefined ? old.year : input.year,
            metadataState: "user",
            updatedAtMs: nowMs,
          })
          .where(eq(catalogItems.id, itemId));
        const metadata = {
          itemId,
          releaseDate: input.releaseDate === undefined ? old.releaseDate : input.releaseDate,
          contentRating:
            input.contentRating === undefined ? old.contentRating : input.contentRating,
          communityRating:
            input.communityRating === undefined ? old.communityRating : input.communityRating,
          genresJson: JSON.stringify(input.genres ?? decodeMetadataList(old.genresJson)),
          studiosJson: JSON.stringify(input.studios ?? decodeMetadataList(old.studiosJson)),
          tagsJson: JSON.stringify(input.tags ?? decodeMetadataList(old.tagsJson)),
          externalIdsJson: old.externalIdsJson ?? "{}",
          fieldSourcesJson: JSON.stringify(fieldSources),
          lockedFieldsJson: JSON.stringify([...locks]),
        };
        yield* transaction.insert(catalogItemMetadata).values(metadata).onConflictDoUpdate({
          target: catalogItemMetadata.itemId,
          set: metadata,
        });
      }),
    );
  });

  const matchItem: CatalogServiceShape["matchItem"] = Effect.fn("Catalog.matchItem")(
    function* (itemId, input) {
      const item = yield* database
        .select({ kind: catalogItems.kind })
        .from(catalogItems)
        .where(eq(catalogItems.id, itemId))
        .get();
      if (item == null || (item.kind !== "movie" && item.kind !== "show"))
        return yield* badRequest("Choose a movie or series");
      const descendantIds = yield* repositories.catalog.descendantItemIds(itemId);
      yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const existing = yield* transaction
            .select({
              externalIdsJson: catalogItemMetadata.externalIdsJson,
              fieldSourcesJson: catalogItemMetadata.fieldSourcesJson,
              lockedFieldsJson: catalogItemMetadata.lockedFieldsJson,
            })
            .from(catalogItemMetadata)
            .where(eq(catalogItemMetadata.itemId, itemId))
            .get();
          const externalIds = {
            ...decodeMetadataMap(existing?.externalIdsJson ?? null),
            tmdb: input.tmdbId,
          };
          const fieldSources = {
            ...decodeMetadataMap(existing?.fieldSourcesJson ?? null),
            tmdb: "user",
          };
          const locks = new Set(decodeMetadataList(existing?.lockedFieldsJson ?? null));
          locks.add("tmdb");
          const metadata = {
            itemId,
            externalIdsJson: JSON.stringify(externalIds),
            fieldSourcesJson: JSON.stringify(fieldSources),
            lockedFieldsJson: JSON.stringify([...locks]),
          };
          yield* transaction.insert(catalogItemMetadata).values(metadata).onConflictDoUpdate({
            target: catalogItemMetadata.itemId,
            set: metadata,
          });
          yield* transaction
            .delete(providerRecords)
            .where(
              and(
                inArray(providerRecords.itemId, descendantIds),
                eq(providerRecords.provider, "tmdb"),
              ),
            );
        }),
      );
    },
  );

  const listItemChildren: CatalogServiceShape["listItemChildren"] = Effect.fn(
    "Catalog.listItemChildren",
  )(function* (principal, itemId, input, nowMs) {
    const offset = decodeCursor(input.cursor);
    if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
    const parent = yield* database
      .select({ libraryId: catalogItems.libraryId })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .get();
    if (parent == null) return yield* notFound("Item not found");
    yield* access.requireLibrary(principal, parent.libraryId, "library:read", nowMs);
    const rows = yield* database
      .select({
        id: catalogItems.id,
        libraryId: catalogItems.libraryId,
        parentId: catalogItems.parentId,
        title: catalogItems.title,
        kind: catalogItems.kind,
        indexNumber: catalogItems.indexNumber,
        durationMs: sql<number | null>`${catalogItems.durationSeconds} * 1000`,
        year: catalogItems.year,
        artworkId: sql<string | null>`(
          select ${catalogItemArtwork.artworkId} from ${catalogItemArtwork}
          where ${catalogItemArtwork.itemId} = ${catalogItems.id}
            and ${catalogItemArtwork.role} in ('poster', 'still')
          order by ${catalogItemArtwork.role} limit 1
        )`,
        resumePositionSeconds: itemWatchStates.positionSeconds,
      })
      .from(catalogItems)
      .leftJoin(
        itemWatchStates,
        and(
          eq(itemWatchStates.itemId, catalogItems.id),
          eq(itemWatchStates.userId, principal.user.id),
        ),
      )
      .where(and(eq(catalogItems.parentId, itemId), eq(catalogItems.libraryId, parent.libraryId)))
      .orderBy(asc(catalogItems.indexNumber), asc(catalogItems.sortTitle), asc(catalogItems.id))
      .limit(input.limit + 1)
      .offset(offset);
    return {
      items: rows.slice(0, input.limit),
      nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
    };
  });

  const nextUp: CatalogServiceShape["nextUp"] = Effect.fn("Catalog.nextUp")(
    function* (principal, itemId, nowMs) {
      const show = yield* database
        .select({ libraryId: catalogItems.libraryId, kind: catalogItems.kind })
        .from(catalogItems)
        .where(eq(catalogItems.id, itemId))
        .get();
      if (show == null || show.kind !== "show") return yield* notFound("Series not found");
      yield* access.requireLibrary(principal, show.libraryId, "library:read", nowMs);
      const season = alias(catalogItems, "season");
      const episode = yield* database
        .select({
          id: catalogItems.id,
          libraryId: catalogItems.libraryId,
          parentId: catalogItems.parentId,
          title: catalogItems.title,
          kind: catalogItems.kind,
          indexNumber: catalogItems.indexNumber,
          durationMs: sql<number | null>`${catalogItems.durationSeconds} * 1000`,
          year: catalogItems.year,
          artworkId: sql<string | null>`(
            select ${catalogItemArtwork.artworkId} from ${catalogItemArtwork}
            where ${catalogItemArtwork.itemId} = ${catalogItems.id}
              and ${catalogItemArtwork.role} = 'still'
          )`,
          resumePositionSeconds: itemWatchStates.positionSeconds,
        })
        .from(catalogItems)
        .leftJoin(season, eq(season.id, catalogItems.parentId))
        .leftJoin(
          itemWatchStates,
          and(
            eq(itemWatchStates.itemId, catalogItems.id),
            eq(itemWatchStates.userId, principal.user.id),
          ),
        )
        .where(
          and(
            or(eq(season.parentId, itemId), eq(catalogItems.parentId, itemId)),
            eq(catalogItems.kind, "episode"),
            sql`coalesce(${itemWatchStates.completed}, 0) = 0`,
          ),
        )
        .orderBy(
          asc(sql`coalesce(${season.indexNumber}, 0)`),
          asc(catalogItems.indexNumber),
          asc(catalogItems.sortTitle),
          asc(catalogItems.id),
        )
        .limit(1)
        .get();
      return { item: episode };
    },
  );

  const itemDetails: CatalogServiceShape["itemDetails"] = Effect.fn("Catalog.itemDetails")(
    function* (principal, itemId, metadataProviderConfigured, nowMs) {
      const item = yield* database
        .select({
          id: catalogItems.id,
          libraryId: catalogItems.libraryId,
          parentId: catalogItems.parentId,
          title: catalogItems.title,
          kind: catalogItems.kind,
          year: catalogItems.year,
          indexNumber: catalogItems.indexNumber,
          overview: catalogItems.overview,
          durationSeconds: catalogItems.durationSeconds,
          releaseDate: catalogItemMetadata.releaseDate,
          contentRating: catalogItemMetadata.contentRating,
          communityRating: catalogItemMetadata.communityRating,
          genresJson: sql<string>`coalesce(${catalogItemMetadata.genresJson}, '[]')`,
          studiosJson: sql<string>`coalesce(${catalogItemMetadata.studiosJson}, '[]')`,
          tagsJson: sql<string>`coalesce(${catalogItemMetadata.tagsJson}, '[]')`,
          externalIdsJson: sql<string>`coalesce(${catalogItemMetadata.externalIdsJson}, '{}')`,
          artworkId: sql<string | null>`(
            select ${catalogItemArtwork.artworkId} from ${catalogItemArtwork}
            where ${catalogItemArtwork.itemId} = ${catalogItems.id}
              and ${catalogItemArtwork.role} = 'poster'
          )`,
          backdropId: sql<string | null>`(
            select ${catalogItemArtwork.artworkId} from ${catalogItemArtwork}
            where ${catalogItemArtwork.itemId} = ${catalogItems.id}
              and ${catalogItemArtwork.role} = 'backdrop'
          )`,
        })
        .from(catalogItems)
        .leftJoin(catalogItemMetadata, eq(catalogItemMetadata.itemId, catalogItems.id))
        .where(eq(catalogItems.id, itemId))
        .get();
      if (item == null) return yield* notFound("Item not found");
      yield* access.requireLibrary(principal, item.libraryId, "library:read", nowMs);
      const sourceRows = yield* database
        .select({
          id: mediaSources.id,
          generation: catalogItemSources.sourceGeneration,
          available: mediaSourceAvailability.isAvailable,
          size: mediaSources.fileSizeBytes,
          modifiedAtMs: mediaSources.modifiedAtMs,
        })
        .from(catalogItemSources)
        .innerJoin(mediaSources, eq(mediaSources.id, catalogItemSources.sourceId))
        .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, mediaSources.id))
        .where(eq(catalogItemSources.itemId, item.id))
        .orderBy(sql`${catalogItemSources.isPrimary} desc`, asc(mediaSources.id));
      const watchState = yield* database
        .select({
          positionSeconds: itemWatchStates.positionSeconds,
          completed: itemWatchStates.completed,
        })
        .from(itemWatchStates)
        .where(
          and(eq(itemWatchStates.userId, principal.user.id), eq(itemWatchStates.itemId, item.id)),
        )
        .get();
      const favorite = yield* database
        .select({ itemId: itemFavorites.itemId })
        .from(itemFavorites)
        .where(and(eq(itemFavorites.userId, principal.user.id), eq(itemFavorites.itemId, item.id)))
        .get();
      return {
        item,
        sources: sourceRows.map((source) => ({
          ...source,
          available: source.available ?? true,
        })),
        watchState: watchState ?? null,
        isFavorite: favorite != null,
        metadataProviderConfigured,
      };
    },
  );

  const setItemFavorite: CatalogServiceShape["setItemFavorite"] = Effect.fn(
    "Catalog.setItemFavorite",
  )(function* (principal, itemId, input, nowMs) {
    const item = yield* database
      .select({ libraryId: catalogItems.libraryId })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .get();
    if (item == null) return yield* notFound("Item not found");
    yield* access.requireLibrary(principal, item.libraryId, "favorites:write", nowMs);
    if (input.isFavorite) {
      yield* database
        .insert(itemFavorites)
        .values({ userId: principal.user.id, itemId, createdAtMs: nowMs })
        .onConflictDoNothing();
    } else {
      yield* database
        .delete(itemFavorites)
        .where(and(eq(itemFavorites.userId, principal.user.id), eq(itemFavorites.itemId, itemId)));
    }
  });

  const setItemWatchState: CatalogServiceShape["setItemWatchState"] = Effect.fn(
    "Catalog.setItemWatchState",
  )(function* (principal, itemId, input, nowMs) {
    const item = yield* database
      .select({ libraryId: catalogItems.libraryId })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .get();
    if (item == null) return yield* notFound("Item not found");
    yield* access.requireLibrary(principal, item.libraryId, "library:read", nowMs);
    yield* database
      .insert(itemWatchStates)
      .values({
        userId: principal.user.id,
        itemId,
        positionSeconds: input.positionSeconds,
        completed: input.completed,
        ownershipGeneration: 1,
        manualVersion: 1,
        updatedAtMs: nowMs,
      })
      .onConflictDoUpdate({
        target: [itemWatchStates.userId, itemWatchStates.itemId],
        set: {
          positionSeconds: input.positionSeconds,
          completed: input.completed,
          manualVersion: sql`${itemWatchStates.manualVersion} + 1`,
          updatedAtMs: nowMs,
        },
      });
  });
  const listTracks: CatalogServiceShape["listTracks"] = Effect.fn("Catalog.listTracks")(
    function* (principal, libraryId, input, nowMs) {
      const offset = decodeCursor(input.cursor);
      if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
      const libraryIds =
        libraryId == null ? yield* access.accessibleLibraryIds(principal, nowMs) : [libraryId];
      if (libraryId !== null)
        yield* access.requireLibrary(principal, libraryId, "library:read", nowMs);
      if (libraryIds.length === 0) return { items: [], nextCursor: null };
      const rows = yield* database
        .select({
          id: tracks.id,
          libraryId: tracks.libraryId,
          title: tracks.title,
          normalizedTitle: tracks.normalizedTitle,
          durationMs: tracks.durationMs,
          albumId: tracks.albumId,
          trackNumber: tracks.trackNumber,
          discNumber: tracks.discNumber,
        })
        .from(tracks)
        .where(inArray(tracks.libraryId, [...libraryIds]))
        .orderBy(asc(tracks.createdAtMs), asc(tracks.id))
        .limit(input.limit + 1)
        .offset(offset);
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: hasMore ? encodeCursor(offset + input.limit) : null };
    },
  );

  const search: CatalogServiceShape["search"] = Effect.fn("Catalog.search")(
    function* (principal, input, nowMs) {
      const offset = decodeCursor(input.cursor);
      if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
      const ids = yield* access.accessibleLibraryIds(principal, nowMs);
      if (input.libraryId !== null)
        yield* access.requireLibrary(principal, input.libraryId, "library:read", nowMs);
      if (ids.length === 0) return { items: [], nextCursor: null };
      const match = buildFtsMatch(input.q);
      const rows = (yield* database
        .select({
          entityType: catalogFts.entityType,
          entityId: catalogFts.entityId,
          title: catalogFts.title,
          subtitle: sql<string | null>`nullif(${catalogFts.subtitle}, '')`,
          rank: sql<number>`bm25(catalog_fts)`,
        })
        .from(catalogFts)
        .where(
          and(
            sql`catalog_fts MATCH ${match}`,
            or(
              and(
                eq(catalogFts.entityType, "artist"),
                exists(
                  database
                    .select({ value: artists.id })
                    .from(artists)
                    .where(
                      and(
                        eq(artists.id, catalogFts.entityId),
                        inArray(artists.libraryId, [...ids]),
                      ),
                    ),
                ),
              ),
              and(
                eq(catalogFts.entityType, "album"),
                exists(
                  database
                    .select({ value: albums.id })
                    .from(albums)
                    .where(
                      and(eq(albums.id, catalogFts.entityId), inArray(albums.libraryId, [...ids])),
                    ),
                ),
              ),
              and(
                eq(catalogFts.entityType, "track"),
                exists(
                  database
                    .select({ value: tracks.id })
                    .from(tracks)
                    .where(
                      and(eq(tracks.id, catalogFts.entityId), inArray(tracks.libraryId, [...ids])),
                    ),
                ),
              ),
            ),
          ),
        )
        .orderBy(sql`bm25(catalog_fts)`, asc(catalogFts.entityType), asc(catalogFts.entityId))
        .limit(input.limit + 1)
        .offset(offset)) as ReadonlyArray<{
        entityType: "artist" | "album" | "track";
        entityId: string;
        title: string;
        subtitle: string | null;
        rank: number;
      }>;
      const hasMore = rows.length > input.limit;
      return {
        items: rows.slice(0, input.limit),
        nextCursor: hasMore ? encodeCursor(offset + input.limit) : null,
      };
    },
  );

  const searchItems: CatalogServiceShape["searchItems"] = Effect.fn("Catalog.searchItems")(
    function* (principal, input, nowMs) {
      const offset = decodeCursor(input.cursor);
      if (!Number.isSafeInteger(offset)) return yield* badRequest("Invalid cursor");
      if (input.libraryId !== null)
        yield* access.requireLibrary(principal, input.libraryId, "library:read", nowMs);
      const libraryIds =
        input.libraryId === null
          ? yield* access.accessibleLibraryIds(principal, nowMs)
          : [input.libraryId];
      if (libraryIds.length === 0) return { items: [], nextCursor: null };
      const match = buildFtsMatch(input.q);
      const rows = yield* database
        .select({
          id: catalogItems.id,
          libraryId: catalogItems.libraryId,
          title: catalogItems.title,
          kind: catalogItems.kind,
          durationMs: sql<number | null>`${catalogItems.durationSeconds} * 1000`,
          year: catalogItems.year,
        })
        .from(catalogItemFts)
        .innerJoin(catalogItems, eq(catalogItems.id, catalogItemFts.itemId))
        .where(
          and(sql`catalog_item_fts MATCH ${match}`, inArray(catalogItems.libraryId, libraryIds)),
        )
        .orderBy(sql`bm25(catalog_item_fts)`, asc(catalogItems.sortTitle), asc(catalogItems.id))
        .limit(input.limit + 1)
        .offset(offset);
      if (rows.length === 0) return yield* search(principal, input, nowMs);
      return {
        items: rows
          .slice(0, input.limit)
          .map((item) => ({ ...item, artworkId: null, resumePositionSeconds: null })),
        nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
      };
    },
  );

  const trackDetails: CatalogServiceShape["trackDetails"] = Effect.fn("Catalog.trackDetails")(
    function* (principal, trackId, nowMs) {
      yield* access.requireTrack(principal, trackId, "library:read", nowMs);
      const trackRow = yield* database.select().from(tracks).where(eq(tracks.id, trackId)).get();
      if (trackRow == null) return yield* notFound("Track not found");
      const track = trackRow;
      const chapters = yield* repositories.catalog
        .listChapters({ streamId: track.primaryStreamId })
        .pipe(Effect.mapError(() => []));
      const metadata = yield* repositories.catalog
        .listMetadata({ trackId })
        .pipe(Effect.mapError(() => []));
      const artworkRows = yield* database
        .select({
          id: artwork.id,
          mimeType: artwork.mimeType,
          width: artwork.width,
          height: artwork.height,
          relativePath: artwork.relativePath,
        })
        .from(artwork)
        .innerJoin(artworkAssignments, eq(artworkAssignments.artworkId, artwork.id))
        .where(and(eq(artworkAssignments.trackId, trackId), eq(artworkAssignments.isPrimary, true)))
        .limit(1);
      return { track, chapters, metadata, artwork: artworkRows };
    },
  );

  const setFavorite: CatalogServiceShape["setFavorite"] = Effect.fn("Catalog.setFavorite")(
    function* (principal, trackId, input, nowMs) {
      yield* access.requireTrack(principal, trackId, "favorites:write", nowMs);
      yield* repositories.activity
        .setFavorite({ userId: principal.user.id, trackId, isFavorite: input.isFavorite, nowMs })
        .pipe(Effect.mapError(() => forbidden("Favorite could not be updated")));
    },
  );

  const setWatchState: CatalogServiceShape["setWatchState"] = Effect.fn("Catalog.setWatchState")(
    function* (principal, trackId, input, nowMs) {
      yield* access.requireTrack(principal, trackId, "library:read", nowMs);
      return yield* repositories.activity
        .upsertWatchState({
          id: crypto.randomUUID(),
          userId: principal.user.id,
          trackId,
          positionMs: input.positionMs,
          completed: input.completed,
          nowMs,
        })
        .pipe(Effect.mapError(() => forbidden("Watch state could not be updated")));
    },
  );
  return {
    listItems,
    updateItemMetadata,
    matchItem,
    listItemChildren,
    nextUp,
    itemDetails,
    setItemFavorite,
    setItemWatchState,
    searchItems,
    listTracks,
    search,
    trackDetails,
    setFavorite,
    setWatchState,
  };
});

export class CatalogService extends Context.Service<CatalogService, CatalogServiceShape>()(
  "@lumen/server/Catalog",
) {}
export const CatalogServiceLive = Layer.effect(CatalogService, makeCatalogService);
