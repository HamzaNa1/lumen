import { Schema } from "effect";
import { CatalogItem, LibrarySummary } from "./models.ts";
import { Uuid } from "./schemas/common";

export const HomeContent = Schema.Struct({
  libraryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  libraries: Schema.Array(LibrarySummary),
  continueWatching: Schema.Array(CatalogItem),
  continueListening: Schema.Array(CatalogItem),
  nextUp: Schema.Array(CatalogItem),
  latest: Schema.Array(
    Schema.Struct({
      libraryId: Uuid,
      libraryName: Schema.String,
      items: Schema.Array(CatalogItem),
    }),
  ),
});
export type HomeContent = Schema.Schema.Type<typeof HomeContent>;
