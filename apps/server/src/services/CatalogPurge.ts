import {
  albumArtists,
  albums,
  artists,
  artwork,
  artworkAssignments,
  catalogItemArtwork,
  catalogItemOutbox,
  catalogItemParents,
  catalogItems,
  catalogItemSources,
  type DatabaseClient,
  libraries,
  mediaSources,
  outboxEvents,
  scanRuns,
  trackArtists,
  tracks,
} from "@lumen/database";
import { and, asc, eq, inArray, isNotNull, notExists, notInArray, or } from "drizzle-orm";
import { Effect } from "effect";
import { queueArtworkSweep } from "../media/GeneratedArtwork";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

export interface SourcePurgeCounts {
  readonly sourcesDeleted: number;
  readonly itemsDeleted: number;
  readonly multiSourceItemsRetained: number;
  readonly containersPruned: Readonly<Record<"show" | "season" | "album" | "artist", number>>;
  readonly artworkDeleted: number;
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

// Deletes artwork rows among the candidates that nothing displays any more.
const deleteUnusedArtwork = (transaction: Transaction, artworkIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (artworkIds.length === 0) return 0;
    const deleted = yield* transaction
      .delete(artwork)
      .where(
        and(
          inArray(artwork.id, [...artworkIds]),
          notExists(
            transaction
              .select({ value: catalogItemArtwork.artworkId })
              .from(catalogItemArtwork)
              .where(eq(catalogItemArtwork.artworkId, artwork.id)),
          ),
          notExists(
            transaction
              .select({ value: artworkAssignments.artworkId })
              .from(artworkAssignments)
              .where(eq(artworkAssignments.artworkId, artwork.id)),
          ),
        ),
      )
      .returning({ id: artwork.id });
    return deleted.length;
  });

// Deletes the given containers, deepest first, once they have no children and no sources.
const pruneEmptyContainers = (transaction: Transaction, candidateIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const pruned = { show: 0, season: 0 };
    let pending = [...candidateIds];
    while (pending.length > 0) {
      const deleted = yield* transaction
        .delete(catalogItems)
        .where(
          and(
            inArray(catalogItems.id, pending),
            inArray(catalogItems.kind, ["show", "season"]),
            notExists(
              transaction
                .select({ value: catalogItemSources.itemId })
                .from(catalogItemSources)
                .where(eq(catalogItemSources.itemId, catalogItems.id)),
            ),
            notInArray(
              catalogItems.id,
              transaction
                .select({ id: catalogItems.parentId })
                .from(catalogItems)
                .where(isNotNull(catalogItems.parentId)),
            ),
            notExists(
              transaction
                .select({ value: catalogItemParents.childId })
                .from(catalogItemParents)
                .where(eq(catalogItemParents.parentId, catalogItems.id)),
            ),
          ),
        )
        .returning({ id: catalogItems.id, kind: catalogItems.kind });
      if (deleted.length === 0) break;
      for (const row of deleted) pruned[row.kind as "show" | "season"] += 1;
      const deletedIds = new Set(deleted.map((row) => row.id));
      pending = pending.filter((id) => !deletedIds.has(id));
    }
    return pruned;
  });

// Deletes albums without tracks, then artists no track or album credits.
const pruneMusic = (
  transaction: Transaction,
  albumIds: ReadonlyArray<string>,
  artistIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const prunedAlbums =
      albumIds.length === 0
        ? []
        : yield* transaction
            .delete(albums)
            .where(
              and(
                inArray(albums.id, [...albumIds]),
                notExists(
                  transaction
                    .select({ value: tracks.id })
                    .from(tracks)
                    .where(eq(tracks.albumId, albums.id)),
                ),
              ),
            )
            .returning({ id: albums.id });
    const prunedArtists =
      artistIds.length === 0
        ? []
        : yield* transaction
            .delete(artists)
            .where(
              and(
                inArray(artists.id, [...artistIds]),
                notExists(
                  transaction
                    .select({ value: trackArtists.trackId })
                    .from(trackArtists)
                    .where(eq(trackArtists.artistId, artists.id)),
                ),
                notExists(
                  transaction
                    .select({ value: albumArtists.albumId })
                    .from(albumArtists)
                    .where(eq(albumArtists.artistId, artists.id)),
                ),
                notExists(
                  transaction
                    .select({ value: albums.id })
                    .from(albums)
                    .where(eq(albums.albumArtistId, artists.id)),
                ),
              ),
            )
            .returning({ id: artists.id });
    return { album: prunedAlbums.length, artist: prunedArtists.length };
  });

const ancestorIds = (transaction: Transaction, itemIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ancestors = new Set<string>();
    let frontier = [...itemIds];
    while (frontier.length > 0) {
      const parents = yield* transaction
        .select({ parentId: catalogItems.parentId })
        .from(catalogItems)
        .where(and(inArray(catalogItems.id, frontier), isNotNull(catalogItems.parentId)));
      frontier = unique(parents.map((row) => row.parentId as string)).filter(
        (id) => !ancestors.has(id),
      );
      for (const id of frontier) ancestors.add(id);
    }
    return [...ancestors];
  });

// Keeps each batch well under SQLite's bound-parameter limit.
const sourceBatchSize = 500;

const emptyCounts: SourcePurgeCounts = {
  sourcesDeleted: 0,
  itemsDeleted: 0,
  multiSourceItemsRetained: 0,
  containersPruned: { show: 0, season: 0, album: 0, artist: 0 },
  artworkDeleted: 0,
};

const addCounts = (left: SourcePurgeCounts, right: SourcePurgeCounts): SourcePurgeCounts => ({
  sourcesDeleted: left.sourcesDeleted + right.sourcesDeleted,
  itemsDeleted: left.itemsDeleted + right.itemsDeleted,
  multiSourceItemsRetained: left.multiSourceItemsRetained + right.multiSourceItemsRetained,
  containersPruned: {
    show: left.containersPruned.show + right.containersPruned.show,
    season: left.containersPruned.season + right.containersPruned.season,
    album: left.containersPruned.album + right.containersPruned.album,
    artist: left.containersPruned.artist + right.containersPruned.artist,
  },
  artworkDeleted: left.artworkDeleted + right.artworkDeleted,
});

// Deletes media sources confirmed missing, and every catalog record that only
// existed because of them. Runs inside the caller's transaction and is
// idempotent: already-deleted sources are ignored, so batches that see each
// other's leftovers converge on the same result.
export const purgeSources = Effect.fn("CatalogPurge.purgeSources")(function* (
  transaction: Transaction,
  sourceIds: ReadonlyArray<string>,
) {
  const ids = unique(sourceIds);
  let counts = emptyCounts;
  for (let start = 0; start < ids.length; start += sourceBatchSize)
    counts = addCounts(
      counts,
      yield* purgeSourceBatch(transaction, ids.slice(start, start + sourceBatchSize)),
    );
  return counts;
});

const purgeSourceBatch = (transaction: Transaction, removedIds: string[]) =>
  Effect.gen(function* () {
    const removed = new Set(removedIds);
    const links = yield* transaction
      .select({ itemId: catalogItemSources.itemId, sourceId: catalogItemSources.sourceId })
      .from(catalogItemSources)
      .where(
        inArray(
          catalogItemSources.itemId,
          transaction
            .select({ itemId: catalogItemSources.itemId })
            .from(catalogItemSources)
            .where(inArray(catalogItemSources.sourceId, removedIds)),
        ),
      );
    const survivingSourceCounts = new Map<string, number>();
    for (const link of links)
      survivingSourceCounts.set(
        link.itemId,
        (survivingSourceCounts.get(link.itemId) ?? 0) + (removed.has(link.sourceId) ? 0 : 1),
      );
    const deletedItemIds = [...survivingSourceCounts]
      .filter(([, count]) => count === 0)
      .map(([id]) => id);
    const containerIds = yield* ancestorIds(transaction, deletedItemIds);

    // Artwork found next to a deleted file may still decorate a surviving show or
    // season. Re-home it on a surviving source from the same root so it stays
    // servable; anything left unattached is deleted below.
    const sourcedArtwork = yield* transaction
      .select({ id: artwork.id, rootId: mediaSources.rootId })
      .from(artwork)
      .innerJoin(mediaSources, eq(mediaSources.id, artwork.sourceId))
      .where(inArray(artwork.sourceId, removedIds));
    for (const row of sourcedArtwork) {
      const replacement = yield* transaction
        .select({ id: mediaSources.id })
        .from(mediaSources)
        .where(and(eq(mediaSources.rootId, row.rootId), notInArray(mediaSources.id, removedIds)))
        .orderBy(asc(mediaSources.relativePath))
        .limit(1)
        .get();
      yield* transaction
        .update(artwork)
        .set({ sourceId: replacement?.id ?? null })
        .where(eq(artwork.id, row.id));
    }
    const removedTracks = yield* transaction
      .select({ id: tracks.id, albumId: tracks.albumId })
      .from(tracks)
      .where(inArray(tracks.sourceId, removedIds));
    const trackIds = removedTracks.map((track) => track.id);
    const albumIds = unique(
      removedTracks.flatMap((track) => (track.albumId === null ? [] : [track.albumId])),
    );
    const albumCredits =
      albumIds.length === 0
        ? []
        : yield* transaction
            .select({ artistId: albums.albumArtistId })
            .from(albums)
            .where(inArray(albums.id, albumIds));
    const creditedArtists =
      trackIds.length === 0
        ? []
        : yield* transaction
            .select({ artistId: trackArtists.artistId })
            .from(trackArtists)
            .where(inArray(trackArtists.trackId, trackIds))
            .union(
              transaction
                .select({ artistId: albumArtists.artistId })
                .from(albumArtists)
                .where(inArray(albumArtists.albumId, albumIds)),
            );
    const artistIds = unique(
      [...albumCredits, ...creditedArtists].flatMap((row) =>
        row.artistId === null ? [] : [row.artistId],
      ),
    );
    const assignedArtwork =
      trackIds.length === 0
        ? []
        : yield* transaction
            .select({ id: artworkAssignments.artworkId })
            .from(artworkAssignments)
            .where(
              or(
                inArray(artworkAssignments.trackId, trackIds),
                inArray(artworkAssignments.albumId, albumIds),
                inArray(artworkAssignments.artistId, artistIds),
              ),
            );
    const itemArtwork = yield* transaction
      .select({ id: catalogItemArtwork.artworkId })
      .from(catalogItemArtwork)
      .where(inArray(catalogItemArtwork.itemId, [...deletedItemIds, ...containerIds]));
    const candidateArtworkIds = unique([
      ...sourcedArtwork.map((row) => row.id),
      ...itemArtwork.map((row) => row.id),
      ...assignedArtwork.map((row) => row.id),
    ]);

    const deletedSources = yield* transaction
      .delete(mediaSources)
      .where(inArray(mediaSources.id, removedIds))
      .returning({ id: mediaSources.id });
    if (deletedItemIds.length > 0) {
      yield* transaction
        .delete(outboxEvents)
        .where(
          inArray(
            outboxEvents.id,
            transaction
              .select({ id: catalogItemOutbox.eventId })
              .from(catalogItemOutbox)
              .where(inArray(catalogItemOutbox.itemId, deletedItemIds)),
          ),
        );
      yield* transaction
        .delete(catalogItemOutbox)
        .where(inArray(catalogItemOutbox.itemId, deletedItemIds));
      yield* transaction.delete(catalogItems).where(inArray(catalogItems.id, deletedItemIds));
    }
    const retainedItemIds = [...survivingSourceCounts]
      .filter(([, count]) => count > 0)
      .map(([id]) => id);
    for (const itemId of retainedItemIds) {
      const primary = yield* transaction
        .select({ sourceId: catalogItemSources.sourceId })
        .from(catalogItemSources)
        .where(and(eq(catalogItemSources.itemId, itemId), eq(catalogItemSources.isPrimary, true)))
        .get();
      if (primary != null) continue;
      const next = yield* transaction
        .select({ sourceId: catalogItemSources.sourceId })
        .from(catalogItemSources)
        .where(eq(catalogItemSources.itemId, itemId))
        .orderBy(asc(catalogItemSources.sourceId))
        .limit(1)
        .get();
      if (next != null)
        yield* transaction
          .update(catalogItemSources)
          .set({ isPrimary: true })
          .where(
            and(
              eq(catalogItemSources.itemId, itemId),
              eq(catalogItemSources.sourceId, next.sourceId),
            ),
          );
    }
    const containersPruned = {
      ...(yield* pruneEmptyContainers(transaction, containerIds)),
      ...(yield* pruneMusic(transaction, albumIds, artistIds)),
    };
    const artworkDeleted = yield* deleteUnusedArtwork(transaction, candidateArtworkIds);
    if (artworkDeleted > 0) yield* queueArtworkSweep(transaction, Date.now());
    return {
      sourcesDeleted: deletedSources.length,
      itemsDeleted: deletedItemIds.length,
      multiSourceItemsRetained: retainedItemIds.length,
      containersPruned,
      artworkDeleted,
    } satisfies SourcePurgeCounts;
  });

export interface LibraryPurgeCounts {
  readonly itemsDeleted: number;
  readonly sourcesDeleted: number;
  readonly tracksDeleted: number;
  readonly albumsDeleted: number;
  readonly artistsDeleted: number;
  readonly artworkDeleted: number;
  readonly scanRunsDeleted: number;
}

// Deletes a library and everything derived from it. Children are removed
// before their parents because several music and artwork references are
// RESTRICT, which a plain cascade from `libraries` would trip over. Runs
// inside the caller's transaction; returns null when the library is unknown.
export const purgeLibrary = Effect.fn("CatalogPurge.purgeLibrary")(function* (
  transaction: Transaction,
  libraryId: string,
) {
  const outbox = transaction
    .select({ id: catalogItemOutbox.eventId })
    .from(catalogItemOutbox)
    .where(eq(catalogItemOutbox.libraryId, libraryId));
  yield* transaction.delete(outboxEvents).where(inArray(outboxEvents.id, outbox));
  yield* transaction.delete(catalogItemOutbox).where(eq(catalogItemOutbox.libraryId, libraryId));
  const deletedArtwork = yield* transaction
    .delete(artwork)
    .where(eq(artwork.libraryId, libraryId))
    .returning({ id: artwork.id });
  const deletedTracks = yield* transaction
    .delete(tracks)
    .where(eq(tracks.libraryId, libraryId))
    .returning({ id: tracks.id });
  const deletedAlbums = yield* transaction
    .delete(albums)
    .where(eq(albums.libraryId, libraryId))
    .returning({ id: albums.id });
  const deletedArtists = yield* transaction
    .delete(artists)
    .where(eq(artists.libraryId, libraryId))
    .returning({ id: artists.id });
  const deletedItems = yield* transaction
    .delete(catalogItems)
    .where(eq(catalogItems.libraryId, libraryId))
    .returning({ id: catalogItems.id });
  const deletedSources = yield* transaction
    .delete(mediaSources)
    .where(eq(mediaSources.libraryId, libraryId))
    .returning({ id: mediaSources.id });
  const deletedRuns = yield* transaction
    .delete(scanRuns)
    .where(eq(scanRuns.libraryId, libraryId))
    .returning({ id: scanRuns.id });
  const deletedLibraries = yield* transaction
    .delete(libraries)
    .where(eq(libraries.id, libraryId))
    .returning({ id: libraries.id });
  if (deletedLibraries.length === 0) return null;
  if (deletedArtwork.length > 0) yield* queueArtworkSweep(transaction, Date.now());
  return {
    itemsDeleted: deletedItems.length,
    sourcesDeleted: deletedSources.length,
    tracksDeleted: deletedTracks.length,
    albumsDeleted: deletedAlbums.length,
    artistsDeleted: deletedArtists.length,
    artworkDeleted: deletedArtwork.length,
    scanRunsDeleted: deletedRuns.length,
  } satisfies LibraryPurgeCounts;
});
