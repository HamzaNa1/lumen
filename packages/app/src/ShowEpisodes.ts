import type { CatalogRuntime } from "@lumen/client/runtime";
import type { CatalogItem, CatalogItemDetails, ShowSummary } from "@lumen/contracts";

type Catalog = Pick<CatalogRuntime, "itemDetails" | "itemChildren">;

/** A show's episodes under one season; `season` is null for episodes filed under the show itself. */
export interface EpisodeGroup {
  readonly season: CatalogItem | null;
  readonly episodes: ReadonlyArray<CatalogItem>;
}

// An episode sits under its show, or under a season of it.
const levelsAboveEpisode = 2;

/**
 * The show an episode belongs to, for servers too old to place an episode in its show: found by
 * walking up from the episode. Null for anything that is not an episode of a show.
 */
export const showOfEpisode = async (
  catalog: Catalog,
  item: CatalogItemDetails["item"],
): Promise<ShowSummary | null> => {
  if (item.kind !== "episode") return null;
  let parentId = item.parentId;
  for (let level = 0; level < levelsAboveEpisode && parentId !== null; level++) {
    const parent = (await catalog.itemDetails(parentId)).item;
    if (parent.kind === "show") return { id: parent.id, title: parent.title };
    parentId = parent.parentId;
  }
  return null;
};

const allChildren = async (catalog: Catalog, parentId: string): Promise<CatalogItem[]> => {
  const children: CatalogItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await catalog.itemChildren(parentId, cursor);
    children.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return children;
};

/** Every episode of a show, season by season, in the order the show's own page lists them. */
export const episodesOfShow = async (
  catalog: Catalog,
  showId: string,
): Promise<ReadonlyArray<EpisodeGroup>> => {
  const children = await allChildren(catalog, showId);
  const seasons = await Promise.all(
    children
      .filter((child) => child.kind === "season")
      .map(async (season) => ({ season, episodes: await allChildren(catalog, season.id) })),
  );
  const loose = children.filter((child) => child.kind === "episode");
  return [...seasons, { season: null, episodes: loose }].filter(
    (group) => group.episodes.length > 0,
  );
};
