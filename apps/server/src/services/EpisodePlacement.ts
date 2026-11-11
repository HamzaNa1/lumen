import { nextEpisode, previousEpisode } from "@lumen/contracts";
import { catalogItems, type DatabaseClient, itemWatchStates } from "@lumen/database";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import {
  completedFor,
  itemArtwork,
  lastEpisode,
  resumePositionSeconds,
  showPlacement,
} from "./CatalogColumns";

const season = alias(catalogItems, "season");

/** A show's episodes in watching order, whether they sit in seasons or directly in the show. */
export const showEpisodes = (database: DatabaseClient, showId: string, userId: string) =>
  database
    .select({
      id: catalogItems.id,
      libraryId: catalogItems.libraryId,
      parentId: catalogItems.parentId,
      title: catalogItems.title,
      kind: catalogItems.kind,
      indexNumber: catalogItems.indexNumber,
      indexNumberEnd: catalogItems.indexNumberEnd,
      seasonNumber: season.indexNumber,
      durationMs: sql<number | null>`${catalogItems.durationSeconds} * 1000`,
      year: catalogItems.year,
      artworkId: itemArtwork("id", ["still"]),
      artworkRevision: itemArtwork("revision", ["still"]),
      completed: completedFor(userId),
      resumePositionSeconds,
    })
    .from(catalogItems)
    .leftJoin(season, eq(season.id, catalogItems.parentId))
    .leftJoin(
      itemWatchStates,
      and(eq(itemWatchStates.itemId, catalogItems.id), eq(itemWatchStates.userId, userId)),
    )
    .where(
      and(
        or(eq(season.parentId, showId), eq(catalogItems.parentId, showId)),
        eq(catalogItems.kind, "episode"),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${season.indexNumber}, 0)`),
      asc(catalogItems.indexNumber),
      asc(lastEpisode),
      asc(catalogItems.sortTitle),
      asc(catalogItems.id),
    );

type ShowEpisode = Effect.Success<ReturnType<typeof showEpisodes>>[number];

export interface EpisodePlacement {
  readonly show: { readonly id: string; readonly title: string };
  readonly seasonNumber: number | null;
  readonly seasonYear: number | null;
  readonly previous: ShowEpisode | null;
  readonly next: ShowEpisode | null;
}

/**
 * Gives each episode of a show its placement, so a client can describe the episode the moment
 * it is played. Anything else is returned as it was.
 */
export const placeEpisodes = <A extends { readonly id: string; readonly kind: string }>(
  database: DatabaseClient,
  userId: string,
  items: ReadonlyArray<A>,
) =>
  Effect.gen(function* () {
    const episodeIds = items.filter((item) => item.kind === "episode").map((item) => item.id);
    if (episodeIds.length === 0)
      return items as ReadonlyArray<A & { placement?: EpisodePlacement }>;
    const place = showPlacement();
    const places = yield* database
      .select({
        id: catalogItems.id,
        showId: place.showId,
        seriesTitle: place.seriesTitle,
        seasonNumber: place.seasonNumber,
        seasonYear: place.seasonYear,
      })
      .from(catalogItems)
      .leftJoin(place.parent, place.onParent)
      .leftJoin(place.show, place.onShow)
      .where(inArray(catalogItems.id, episodeIds));
    const episodesByShow = new Map<string, ReadonlyArray<ShowEpisode>>();
    for (const showId of new Set(places.map((row) => row.showId))) {
      if (showId !== null)
        episodesByShow.set(showId, yield* showEpisodes(database, showId, userId));
    }
    const placements = new Map<string, EpisodePlacement>();
    for (const row of places) {
      const episodes = row.showId === null ? undefined : episodesByShow.get(row.showId);
      if (episodes === undefined || row.showId === null || row.seriesTitle === null) continue;
      const index = episodes.findIndex((episode) => episode.id === row.id);
      placements.set(row.id, {
        show: { id: row.showId, title: row.seriesTitle },
        seasonNumber: row.seasonNumber,
        seasonYear: row.seasonYear,
        previous: previousEpisode(episodes, index),
        next: nextEpisode(episodes, index),
      });
    }
    return items.map((item) => {
      const placement = placements.get(item.id);
      return placement === undefined ? item : { ...item, placement };
    });
  });
