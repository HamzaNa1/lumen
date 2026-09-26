import { Schema } from "effect";

const TmdbSeriesId = Schema.String.check(Schema.isPattern(/^\d+$/u));
const TmdbEpisodeGroupId = Schema.String.check(Schema.isPattern(/^[a-f\d]{24}$/u));

export const EpisodeOrderSelection = Schema.Struct({
  tmdbSeriesId: TmdbSeriesId,
  groupId: Schema.NullOr(TmdbEpisodeGroupId),
});
export type EpisodeOrderSelection = Schema.Schema.Type<typeof EpisodeOrderSelection>;

export const EpisodeOrderOptions = Schema.Struct({
  tmdbSeriesId: TmdbSeriesId,
  groupId: Schema.NullOr(TmdbEpisodeGroupId),
  groups: Schema.Array(
    Schema.Struct({
      id: TmdbEpisodeGroupId,
      name: Schema.String,
      description: Schema.String,
      type: Schema.String,
    }),
  ),
});
export type EpisodeOrderOptions = Schema.Schema.Type<typeof EpisodeOrderOptions>;
