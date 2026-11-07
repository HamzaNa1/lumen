import { EpisodeOrderOptions } from "@lumen/contracts";
import { Schema } from "effect";
import { fetchTmdb } from "./TmdbClient";
import type { TmdbSeasonEpisode } from "./TmdbEpisodeMatch";

const orderTypes: Record<number, string> = {
  1: "Original air date",
  2: "Absolute",
  3: "DVD",
  4: "Digital",
  5: "Story arc",
  6: "Production",
  7: "TV",
};
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Group = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      order: Index,
      episodes: Schema.Array(
        Schema.Struct({
          order: Index,
          season_number: Index,
          episode_number: Index,
          name: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
});

export const tmdbEpisodeOrders = async (
  tmdbSeriesId: string,
  groupId: string | null,
  key: string,
) => {
  const payload = await fetchTmdb(`/tv/${tmdbSeriesId}/episode_groups`, key);
  const list = Schema.decodeUnknownSync(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          description: Schema.NullOr(Schema.String),
          type: Schema.Int,
        }),
      ),
    }),
  )(payload);
  return Schema.decodeUnknownSync(EpisodeOrderOptions)({
    tmdbSeriesId,
    groupId,
    groups: list.results.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description ?? "",
      type: orderTypes[entry.type] ?? "Alternate",
    })),
  });
};

/**
 * Every episode the selected order places in a local season, with where TMDb itself files it. A
 * season the order lists other than exactly once has no episodes, since none could be placed.
 */
export const tmdbEpisodeGroupSeason = async (
  groupId: string,
  seasonNumber: number,
  key: string,
): Promise<TmdbSeasonEpisode[]> => {
  const group = Schema.decodeUnknownSync(Group)(
    await fetchTmdb(`/tv/episode_group/${groupId}`, key),
  );
  const seasons = group.groups.filter((season) => season.order === seasonNumber);
  const [season] = seasons;
  if (seasons.length !== 1 || season === undefined) return [];
  return season.episodes.map((episode) => ({
    position: episode.order + 1,
    seasonNumber: episode.season_number,
    episodeNumber: episode.episode_number,
    name: episode.name?.trim() || null,
  }));
};
