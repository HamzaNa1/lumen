import { MAX_COMBINED_EPISODES } from "@lumen/contracts";
import {
  fetchTmdb,
  num,
  object,
  str,
  TmdbHttpError,
  type TmdbObject,
  tmdbImageUrl,
} from "./TmdbClient";
import { tmdbEpisodeGroupSeason } from "./TmdbEpisodeOrder";

/** One TMDb episode as a season lists it, under the series' selected episode order. */
export interface TmdbSeasonEpisode {
  /** The episode's number in the local season under the selected order. */
  readonly position: number;
  /** Where TMDb itself files the episode. */
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly name: string | null;
}

/** A local episode entry: the episode numbers its file covers and the title its file name gives. */
export interface LocalEpisode {
  readonly numbers: ReadonlyArray<number>;
  readonly title: string | null;
}

export interface EpisodeMatch {
  readonly episodes: ReadonlyArray<TmdbSeasonEpisode>;
  readonly confidence: number;
}

/** Number and title agree. */
const AGREED = 95;
/** The title found the episode under another number, as when sources count two-parters differently. */
const BY_TITLE = 90;
/** Only the number placed a file whose title named no episode, as a translated title would. */
const BY_NUMBER_ONLY = 80;

const partNumbers: Record<string, number> = { one: 1, two: 2, three: 3, i: 1, ii: 2, iii: 3 };
const part =
  /\s*(?:\(\s*(?:part\s*|pt\s*)?(\d+|one|two|three|i{1,3})\s*\)|\b(?:part|pt)\s*(\d+|one|two|three|i{1,3}))$/u;

/**
 * A title reduced to what tells episodes apart: case, accents, punctuation, apostrophes and articles go, "&" reads
 * as "and", and a closing part marker such as "(2)" or "Part 2" is kept apart as `part`.
 */
export const episodeTitleKey = (title: string): { base: string; part: number | null } | null => {
  const plain = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/['’]/gu, "")
    .replace(/[.:,;!?"-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const marker = part.exec(plain);
  const label = marker?.[1] ?? marker?.[2];
  const base = (marker === null ? plain : plain.slice(0, marker.index))
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\b(?:the|a|an)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (base === "") return null;
  return {
    base,
    part: label === undefined ? null : (partNumbers[label] ?? Number(label)),
  };
};

/**
 * The episodes an entry's title names: every episode with the same title, where a title naming a
 * part matches only that part or an episode not split into parts. Nothing when the title is missing
 * or its matches are not one consecutive run of episodes a file could hold.
 */
const titleMatches = (
  title: string | null,
  candidates: ReadonlyArray<TmdbSeasonEpisode>,
): TmdbSeasonEpisode[] => {
  const key = title === null ? null : episodeTitleKey(title);
  if (key === null) return [];
  const matches = candidates
    .filter((candidate) => {
      const other = candidate.name === null ? null : episodeTitleKey(candidate.name);
      return (
        other !== null &&
        other.base === key.base &&
        (key.part === null || other.part === null || other.part === key.part)
      );
    })
    .sort((a, b) => a.position - b.position);
  const consecutive = matches.every(
    (match, index) => index === 0 || match.position === (matches[index - 1]?.position ?? 0) + 1,
  );
  return consecutive && matches.length <= MAX_COMBINED_EPISODES ? matches : [];
};

/**
 * The TMDb episodes a local entry describes. A file's title is trusted over its number, since
 * release tools and TMDb often count the same season differently, for example splitting a
 * two-parter TMDb lists once. A file the title cannot place falls back to its number, unless
 * another file's title already claims that episode; a file neither places keeps its own metadata.
 */
export const matchEpisode = (
  entry: LocalEpisode,
  others: ReadonlyArray<LocalEpisode>,
  candidates: ReadonlyArray<TmdbSeasonEpisode>,
): EpisodeMatch | null => {
  const byTitle = titleMatches(entry.title, candidates);
  if (byTitle.length > 0) {
    const agreed =
      byTitle.length === entry.numbers.length &&
      byTitle.every((episode, index) => episode.position === entry.numbers[index]);
    return { episodes: byTitle, confidence: agreed ? AGREED : BY_TITLE };
  }
  const claimed = new Set(
    others.flatMap((other) => titleMatches(other.title, candidates)).map((match) => match.position),
  );
  const byNumber: TmdbSeasonEpisode[] = [];
  for (const number of entry.numbers) {
    if (claimed.has(number)) return null;
    const found = candidates.filter((candidate) => candidate.position === number);
    const [episode] = found;
    if (found.length !== 1 || episode === undefined) return null;
    byNumber.push(episode);
  }
  if (byNumber.length === 0) return null;
  return { episodes: byNumber, confidence: entry.title === null ? AGREED : BY_NUMBER_ONLY };
};

/** Every episode of a local season under the series' selected order: TMDb's own, or a group's. */
export const tmdbSeasonEpisodes = async (
  seriesId: string,
  seasonNumber: number,
  groupId: string | null,
  key: string,
): Promise<TmdbSeasonEpisode[]> => {
  if (groupId !== null) return tmdbEpisodeGroupSeason(groupId, seasonNumber, key);
  let season: TmdbObject;
  try {
    season = await fetchTmdb(`/tv/${seriesId}/season/${seasonNumber}`, key);
  } catch (cause) {
    if (cause instanceof TmdbHttpError && cause.status === 404) return [];
    throw cause;
  }
  return (Array.isArray(season.episodes) ? season.episodes : []).flatMap((value) => {
    const episode = object(value);
    const episodeNumber = num(episode.episode_number);
    if (episodeNumber === null || !Number.isInteger(episodeNumber)) return [];
    return [{ position: episodeNumber, seasonNumber, episodeNumber, name: str(episode.name) }];
  });
};

const distinct = (values: ReadonlyArray<string>): string[] => [...new Set(values)];

/**
 * One entry's metadata from every episode its file covers: titles joined as "Part 1 / Part 2",
 * overviews in episode order, and the first episode's air date and still. The episodes' own
 * payloads are kept alongside.
 */
const combinedEpisode = (episodes: ReadonlyArray<TmdbObject>): TmdbObject => {
  const [first] = episodes;
  if (first === undefined) throw new Error("TMDb returned no episodes");
  if (episodes.length === 1) return first;
  const names = episodes.map((episode) => str(episode.name));
  const overviews = episodes
    .map((episode) => str(episode.overview))
    .filter((overview): overview is string => overview !== null);
  const ratings = episodes
    .map((episode) => num(episode.vote_average))
    .filter((rating): rating is number => rating !== null && rating > 0);
  return {
    ...first,
    // A title naming only some of the episodes would read as complete, so it needs every name.
    name: names.every((name) => name !== null) ? distinct(names).join(" / ") : null,
    overview: overviews.length === 0 ? null : distinct(overviews).join("\n\n"),
    vote_average:
      ratings.length === 0
        ? null
        : Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10,
    still_path:
      episodes.map((episode) => episode.still_path).find((path) => tmdbImageUrl("w780", path)) ??
      null,
    episodes,
  };
};

/**
 * TMDb's metadata for a local episode entry of the season TMDb knows as `seasonProviderId`
 * ("series:season"), placed by `matchEpisode` among the season's other entries. Null leaves the
 * entry's local metadata in place; under a selected episode order an entry it cannot place is an
 * error, so the choice of order can be revisited.
 */
export const tmdbEpisode = async (input: {
  readonly seasonProviderId: string;
  readonly entry: LocalEpisode;
  readonly others: ReadonlyArray<LocalEpisode>;
  readonly groupId: string | null;
  readonly key: string;
}): Promise<{ id: string; payload: TmdbObject; confidence: number } | null> => {
  const [seriesId, season] = input.seasonProviderId.split(":");
  const seasonNumber = Number(season);
  if (seriesId === undefined || !Number.isInteger(seasonNumber)) return null;
  const candidates = await tmdbSeasonEpisodes(seriesId, seasonNumber, input.groupId, input.key);
  const match = matchEpisode(input.entry, input.others, candidates);
  if (match === null) {
    if (input.groupId === null) return null;
    throw new Error(
      `Selected episode order has no unique match for S${seasonNumber}E${input.entry.numbers.join("-E")}. Choose another episode order.`,
    );
  }
  // Every episode a combined file covers must resolve; a failure leaves the entry's local
  // metadata and range in place rather than describing only some of its episodes.
  const episodes: TmdbObject[] = [];
  for (const episode of match.episodes)
    episodes.push(
      await fetchTmdb(
        `/tv/${seriesId}/season/${episode.seasonNumber}/episode/${episode.episodeNumber}`,
        input.key,
      ),
    );
  return {
    id: match.episodes
      .map((episode) => `${seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`)
      .join(","),
    payload: combinedEpisode(episodes),
    confidence: match.confidence,
  };
};
