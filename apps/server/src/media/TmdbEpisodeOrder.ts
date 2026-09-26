import { EpisodeOrderOptions } from "@lumen/contracts";
import { Schema } from "effect";
import { fetchTmdb } from "./TmdbClient";

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

export const tmdbEpisodeCoordinates = async (
  groupId: string,
  seasonNumber: number,
  episodeNumber: number,
  key: string,
): Promise<{ seasonNumber: number; episodeNumber: number }> => {
  const group = Schema.decodeUnknownSync(Group)(
    await fetchTmdb(`/tv/episode_group/${groupId}`, key),
  );
  const seasons = group.groups.filter((season) => season.order === seasonNumber);
  const episodes =
    seasons.length === 1
      ? (seasons[0]?.episodes.filter((episode) => episode.order === episodeNumber - 1) ?? [])
      : [];
  const episode = episodes.length === 1 ? episodes[0] : undefined;
  if (episode === undefined)
    throw new Error(
      `Selected episode order has no unique match for S${seasonNumber}E${episodeNumber}. Choose another episode order.`,
    );
  return { seasonNumber: episode.season_number, episodeNumber: episode.episode_number };
};
