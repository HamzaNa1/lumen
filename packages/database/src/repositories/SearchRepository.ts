import { CatalogSearchResult, SearchCatalog } from "@lumen/contracts";
import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
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
    const match = value.query
      .trim()
      .split(/\s+/u)
      .map((term) => `"${term.replaceAll('"', '""')}"*`)
      .join(" AND ");
    const rows = yield* guard(
      database.all<SearchRow>(sql`
        SELECT
          catalog_fts.entity_type AS entityType,
          catalog_fts.entity_id AS entityId,
          catalog_fts.title AS title,
          nullif(catalog_fts.subtitle, '') AS subtitle,
          bm25(catalog_fts) AS rank
        FROM catalog_fts
        WHERE catalog_fts MATCH ${match}
          AND (
            ${value.libraryId} IS NULL
            OR CASE catalog_fts.entity_type
              WHEN 'artist' THEN EXISTS (
                SELECT 1 FROM artists WHERE artists.id = catalog_fts.entity_id AND artists.library_id = ${value.libraryId}
              )
              WHEN 'album' THEN EXISTS (
                SELECT 1 FROM albums WHERE albums.id = catalog_fts.entity_id AND albums.library_id = ${value.libraryId}
              )
              WHEN 'track' THEN EXISTS (
                SELECT 1 FROM tracks WHERE tracks.id = catalog_fts.entity_id AND tracks.library_id = ${value.libraryId}
              )
              ELSE 0
            END
          )
        ORDER BY bm25(catalog_fts), catalog_fts.entity_type, catalog_fts.entity_id
        LIMIT ${value.limit} OFFSET ${value.offset}
      `),
      "search.search",
    );
    return yield* boundary(Schema.Array(CatalogSearchResult), rows, "search.search.result");
  });

  return { search };
};

export type SearchRepository = ReturnType<typeof makeSearchRepository>;
