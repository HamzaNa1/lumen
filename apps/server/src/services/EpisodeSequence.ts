import {
  coveredEpisodeNumbers,
  type EpisodeNumbering,
  lastEpisodeNumber,
} from "@lumen/contracts";

/** A show's episode entry, listed in watching order: by season, then by first episode. */
export interface SequencedEpisode extends EpisodeNumbering {
  readonly seasonNumber?: number | null | undefined;
  readonly completed: boolean;
}

// Entries in different seasons, or without a known place, follow the watching order alone.
const comparable = (a: SequencedEpisode, b: SequencedEpisode): boolean =>
  (a.seasonNumber ?? 0) === (b.seasonNumber ?? 0) && a.indexNumber != null && b.indexNumber != null;

/**
 * The entry after `index` that reaches an episode the entry at `index` does not cover, so a
 * combined file is followed by the episode after its last, not by a file of one it already held.
 */
export const nextEpisode = <A extends SequencedEpisode>(
  episodes: ReadonlyArray<A>,
  index: number,
): A | null => {
  const current = episodes[index];
  if (current === undefined) return null;
  return (
    episodes
      .slice(index + 1)
      .find(
        (episode) =>
          !comparable(episode, current) ||
          (lastEpisodeNumber(episode) ?? 0) > (lastEpisodeNumber(current) ?? 0),
      ) ?? null
  );
};

/** The entry before `index` that starts before it, skipping files of episodes it already holds. */
export const previousEpisode = <A extends SequencedEpisode>(
  episodes: ReadonlyArray<A>,
  index: number,
): A | null => {
  const current = episodes[index];
  if (current === undefined) return null;
  return (
    episodes
      .slice(0, index)
      .findLast(
        (episode) =>
          !comparable(episode, current) ||
          (episode.indexNumber ?? 0) < (current.indexNumber ?? 0),
      ) ?? null
  );
};

/**
 * The first entry the viewer has not finished, skipping any whose every episode a finished entry
 * already covered, such as the second part of a finished two-part file.
 */
export const firstUnwatchedEpisode = <A extends SequencedEpisode>(
  episodes: ReadonlyArray<A>,
): A | null => {
  const watched = new Set(
    episodes
      .filter((episode) => episode.completed)
      .flatMap((episode) =>
        coveredEpisodeNumbers(episode).map((number) => `${episode.seasonNumber ?? 0}:${number}`),
      ),
  );
  return (
    episodes.find((episode) => {
      if (episode.completed) return false;
      const numbers = coveredEpisodeNumbers(episode);
      return (
        numbers.length === 0 ||
        numbers.some((number) => !watched.has(`${episode.seasonNumber ?? 0}:${number}`))
      );
    }) ?? null
  );
};
