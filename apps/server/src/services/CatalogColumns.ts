import { artwork, catalogItemArtwork, catalogItems, itemWatchStates } from "@lumen/database";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

type ArtworkRole = "poster" | "still" | "backdrop";

/**
 * One of an item's images, preferring the earlier role: its artwork ID, or the content hash a
 * client names to fetch exactly those bytes.
 */
export const itemArtwork = (column: "id" | "revision", roles: ReadonlyArray<ArtworkRole>) => sql<
  string | null
>`(
  select ${column === "id" ? artwork.id : artwork.contentHash} from ${catalogItemArtwork}
  join ${artwork} on ${artwork.id} = ${catalogItemArtwork.artworkId}
  where ${catalogItemArtwork.itemId} = ${catalogItems.id}
    and ${catalogItemArtwork.role} in (${sql.join(
      roles.map((role) => sql`${role}`),
      sql`, `,
    )})
  order by ${catalogItemArtwork.role} limit 1
)`;

// Entries starting at the same episode list a single episode before a file of several.
export const lastEpisode = sql`coalesce(${catalogItems.indexNumberEnd}, ${catalogItems.indexNumber})`;

// Where the viewer left off; finished items have nothing to resume.
export const resumePositionSeconds = sql<
  number | null
>`case when ${itemWatchStates.completed} then null else ${itemWatchStates.positionSeconds} end`;

// A season is watched only when it has episodes and every episode is watched.
// Derive it from children so new episodes and individual undo actions stay accurate.
export const completedFor = (userId: string) =>
  sql<boolean>`case
  when ${catalogItems.kind} = 'season' then
    exists (select 1 from catalog_items e where e.parent_id = ${catalogItems.id}
      and e.library_id = ${catalogItems.libraryId} and e.kind = 'episode')
    and not exists (select 1 from catalog_items e
      left join item_watch_states w on w.item_id = e.id and w.user_id = ${userId}
      where e.parent_id = ${catalogItems.id} and e.library_id = ${catalogItems.libraryId}
        and e.kind = 'episode' and coalesce(w.completed, 0) = 0)
  else coalesce((select w.completed from item_watch_states w
    where w.item_id = ${catalogItems.id} and w.user_id = ${userId}), 0)
  end`.mapWith(Boolean);

/**
 * Joins that find where an item sits in a show: `parent` is its season or show, and `show` the
 * show above a season.
 */
export const showPlacement = () => {
  const parent = alias(catalogItems, "parent");
  const show = alias(catalogItems, "show");
  return {
    parent,
    show,
    onParent: and(
      eq(parent.id, catalogItems.parentId),
      eq(parent.libraryId, catalogItems.libraryId),
    ),
    onShow: and(
      eq(show.id, parent.parentId),
      eq(show.libraryId, catalogItems.libraryId),
      eq(show.kind, "show"),
    ),
    // An episode sits in a season of its show, or directly in the show.
    showId: sql<string | null>`case ${parent.kind}
      when 'show' then ${parent.id} when 'season' then ${show.id} end`,
    seriesTitle: sql<string | null>`case ${parent.kind}
      when 'show' then ${parent.title} when 'season' then ${show.title} end`,
    seasonNumber: sql<
      number | null
    >`case when ${parent.kind} = 'season' then ${parent.indexNumber} end`,
    // A season without a year of its own is dated by its show.
    seasonYear: sql<number | null>`case ${parent.kind}
      when 'show' then ${parent.year} when 'season' then coalesce(${parent.year}, ${show.year}) end`,
  };
};
