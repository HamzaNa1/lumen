import { Schema } from "effect";
import { NonEmptyText, Uuid } from "./common";

export const CatalogSearchResult = Schema.Struct({
  entityType: Schema.Literals(["artist", "album", "track"]),
  entityId: Uuid,
  title: NonEmptyText,
  subtitle: Schema.NullOr(Schema.String),
  rank: Schema.Number,
});
export type CatalogSearchResult = Schema.Schema.Type<typeof CatalogSearchResult>;

export const Pagination = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Pagination = Schema.Schema.Type<typeof Pagination>;

export const SearchCatalog = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  libraryId: Schema.NullOr(Uuid),
});
export type SearchCatalog = Schema.Schema.Type<typeof SearchCatalog>;
