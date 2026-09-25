import { CatalogSearchResult, SearchCatalog } from "@lumen/contracts";
import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import { buildFtsMatch } from "../Fts";
import { albums, artists, tracks } from "../tables/schema";
import { catalogFts } from "../tables/SearchSchema";
import { boundary, guard } from "./Boundary";

interface SearchRow {
  readonly entityType: string;
  readonly entityId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly rank: number;
}

export const makeSearchRepository = (database: DatabaseClient) => {
  const search = Effect.fn("SearchRepository.search")(function* (input: unknown) {
    const value = yield* boundary(SearchCatalog, input, "search.search");
    const match = buildFtsMatch(value.query);
    const libraryFilter =
      value.libraryId === null
        ? undefined
        : or(
            and(
              eq(catalogFts.entityType, "artist"),
              exists(
                database
                  .select({ value: artists.id })
                  .from(artists)
                  .where(
                    and(
                      eq(artists.id, catalogFts.entityId),
                      eq(artists.libraryId, value.libraryId),
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
                    and(eq(albums.id, catalogFts.entityId), eq(albums.libraryId, value.libraryId)),
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
                    and(eq(tracks.id, catalogFts.entityId), eq(tracks.libraryId, value.libraryId)),
                  ),
              ),
            ),
          );
    const rows = yield* guard(
      database
        .select({
          entityType: catalogFts.entityType,
          entityId: catalogFts.entityId,
          title: catalogFts.title,
          subtitle: sql<string | null>`nullif(${catalogFts.subtitle}, '')`,
          rank: sql<number>`bm25(catalog_fts)`,
        })
        .from(catalogFts)
        .where(and(sql`catalog_fts MATCH ${match}`, libraryFilter))
        .orderBy(sql`bm25(catalog_fts)`, asc(catalogFts.entityType), asc(catalogFts.entityId))
        .limit(value.limit)
        .offset(value.offset),
      "search.search",
    );
    return yield* boundary(
      Schema.Array(CatalogSearchResult),
      rows as ReadonlyArray<SearchRow>,
      "search.search.result",
    );
  });

  return { search };
};

export type SearchRepository = ReturnType<typeof makeSearchRepository>;
