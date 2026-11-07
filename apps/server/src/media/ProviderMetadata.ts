import {
  catalogItemArtwork,
  catalogItemMetadata,
  catalogItems,
  type DatabaseTransaction,
  providerRecords,
} from "@lumen/database";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { decodeMetadataList, decodeMetadataMap } from "./MetadataJson";

/**
 * Drops an item's provider metadata once it no longer describes the item, as when its file is
 * renumbered or a refresh can no longer place it: provider rows, provider-sourced metadata and
 * provider artwork all go, and title and year return to what the item's path gives, while values
 * the user, an NFO or a field lock owns survive.
 */
export const revertToPathMetadata = (
  transaction: DatabaseTransaction,
  itemId: string,
  local: { readonly title: string; readonly year: number | null },
) =>
  Effect.gen(function* () {
    const current = yield* transaction
      .select({ metadataState: catalogItems.metadataState })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .get();
    yield* transaction
      .delete(providerRecords)
      .where(and(eq(providerRecords.itemId, itemId), eq(providerRecords.provider, "tmdb")));
    yield* transaction
      .delete(catalogItemArtwork)
      .where(and(eq(catalogItemArtwork.itemId, itemId), eq(catalogItemArtwork.source, "tmdb")));
    const stored = yield* transaction
      .select()
      .from(catalogItemMetadata)
      .where(eq(catalogItemMetadata.itemId, itemId))
      .get();
    const locks = new Set(decodeMetadataList(stored?.lockedFieldsJson ?? null));
    const sources = decodeMetadataMap(stored?.fieldSourcesJson ?? null);
    const providerOwned = (field: string): boolean =>
      !locks.has(field) && sources[field] !== "user" && sources[field] !== "nfo";
    const resetTitle = providerOwned("title");
    const resetOverview = providerOwned("overview");
    const resetYear = providerOwned("year");
    if (stored !== undefined) {
      const externalIds = decodeMetadataMap(stored.externalIdsJson);
      if (!locks.has("tmdb") && sources.tmdb !== "user") {
        delete externalIds.tmdb;
        delete sources.tmdb;
      }
      for (const field of [
        "title",
        "overview",
        "year",
        "releaseDate",
        "contentRating",
        "communityRating",
        "genres",
        "studios",
        "tags",
      ] as const)
        if (providerOwned(field)) delete sources[field];
      const metadata = {
        itemId,
        releaseDate: providerOwned("releaseDate") ? null : stored.releaseDate,
        contentRating: providerOwned("contentRating") ? null : stored.contentRating,
        communityRating: providerOwned("communityRating") ? null : stored.communityRating,
        genresJson: JSON.stringify(
          providerOwned("genres") ? [] : decodeMetadataList(stored.genresJson),
        ),
        studiosJson: JSON.stringify(
          providerOwned("studios") ? [] : decodeMetadataList(stored.studiosJson),
        ),
        tagsJson: JSON.stringify(providerOwned("tags") ? [] : decodeMetadataList(stored.tagsJson)),
        externalIdsJson: JSON.stringify(externalIds),
        fieldSourcesJson: JSON.stringify(sources),
        lockedFieldsJson: stored.lockedFieldsJson,
      };
      yield* transaction.insert(catalogItemMetadata).values(metadata).onConflictDoUpdate({
        target: catalogItemMetadata.itemId,
        set: metadata,
      });
    }
    // The state falls back to path only when every value path state owns is the path's again.
    if (resetTitle || resetOverview || resetYear) {
      const reset: {
        title?: string;
        sortTitle?: string;
        overview?: null;
        year?: number | null;
        metadataState?: string;
        updatedAtMs?: number;
      } = { updatedAtMs: Date.now() };
      if (resetTitle) {
        reset.title = local.title;
        reset.sortTitle = local.title.toLowerCase();
      }
      if (resetOverview) reset.overview = null;
      if (resetYear) reset.year = local.year;
      if (resetTitle && resetYear && current?.metadataState === "tmdb")
        reset.metadataState = "path";
      yield* transaction.update(catalogItems).set(reset).where(eq(catalogItems.id, itemId));
    }
  });
