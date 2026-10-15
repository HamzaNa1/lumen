/**
 * Where an episode entry sits in its season. A file holding several consecutive episodes is one
 * entry: `indexNumber` is its first episode and `indexNumberEnd` its last; a single episode has no
 * end.
 */
export interface EpisodeNumbering {
  readonly indexNumber?: number | null | undefined;
  readonly indexNumberEnd?: number | null | undefined;
}

/** The most episodes one file is taken to hold; a longer "range" is more likely part of a title. */
export const MAX_COMBINED_EPISODES = 10;

/** Whether `start`–`end` is a range one combined file can cover. */
export const isEpisodeRange = (start: number, end: number): boolean =>
  Number.isSafeInteger(start) &&
  Number.isSafeInteger(end) &&
  start >= 0 &&
  end > start &&
  end - start < MAX_COMBINED_EPISODES;

/** The last episode an entry covers; null where its place in the season is not known. */
export const lastEpisodeNumber = (entry: EpisodeNumbering): number | null =>
  entry.indexNumber == null ? null : (entry.indexNumberEnd ?? entry.indexNumber);

/** Every episode number an entry covers, in order; empty where its place is not known. */
export const coveredEpisodeNumbers = (entry: EpisodeNumbering): number[] => {
  const first = entry.indexNumber;
  const last = lastEpisodeNumber(entry);
  if (first == null || last == null) return [];
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
};

/** How many episodes an entry counts as; an entry of unknown place is still one episode. */
export const coveredEpisodeCount = (entry: EpisodeNumbering): number =>
  Math.max(1, coveredEpisodeNumbers(entry).length);
