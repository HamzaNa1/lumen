import { Schema } from "effect";

const TmdbId = Schema.String.check(Schema.isPattern(/^\d+$/u));

export const MetadataMatchSelection = Schema.Struct({ tmdbId: TmdbId });
export type MetadataMatchSelection = Schema.Schema.Type<typeof MetadataMatchSelection>;

export const MetadataMatchCandidate = Schema.Struct({
  tmdbId: TmdbId,
  title: Schema.String,
  year: Schema.NullOr(Schema.Int),
  overview: Schema.String,
  /** A data URL, since clients only load images from their own server. */
  posterUrl: Schema.NullOr(Schema.String),
});
export type MetadataMatchCandidate = Schema.Schema.Type<typeof MetadataMatchCandidate>;

export const MetadataMatchOptions = Schema.Struct({
  /** The title this item is matched to now, or null when it has no match. */
  tmdbId: Schema.NullOr(TmdbId),
  query: Schema.String,
  candidates: Schema.Array(MetadataMatchCandidate),
});
export type MetadataMatchOptions = Schema.Schema.Type<typeof MetadataMatchOptions>;
