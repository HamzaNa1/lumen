import { isEpisodeRange } from "@lumen/contracts";
import { basename, extname } from "node:path";

export interface VideoPath {
  readonly kind: "movie" | "episode";
  readonly title: string;
  readonly year: number | null;
  readonly providerId: string | null;
  readonly imdbId: string | null;
  readonly show: { readonly path: string; readonly title: string; readonly year: number | null; readonly providerId: string | null; readonly imdbId: string | null } | null;
  readonly season: { readonly path: string; readonly number: number } | null;
  readonly episodeNumber: number | null;
  /** The last episode of a file holding several consecutive episodes; null for one episode. */
  readonly episodeNumberEnd: number | null;
  readonly warning: string | null;
}

const clean = (value: string): string => value
  .replace(/\s*\[(?:tmdbid|tmdb|imdbid|imdb)-[^\]]+\]/giu, "")
  .replace(/\s*\((?:19|20)\d{2}\)\s*$/u, "")
  .replace(/[._]+/gu, " ").replace(/\s+/gu, " ").trim() || "Untitled";

const name = (value: string) => ({
  title: clean(value),
  year: Number(/\((?:19|20)\d{2}\)/u.exec(value)?.[0].slice(1, -1)) || null,
  providerId: /\[(?:tmdbid|tmdb)-(\d+)\]/iu.exec(value)?.[1] ?? null,
  imdbId: /\[(?:imdbid|imdb)-(tt\d+)\]/iu.exec(value)?.[1] ?? null,
});

// The season and first episode of "S03E10". Later episodes are read by `episodeCoordinates`.
const firstEpisode = /(?:^|[^a-z\d])s(\d{1,2})e(\d{1,3})(?!\d)/giu;
// One later episode: "-E11", "E11" or "-11", its number read to the end of its digits.
const laterEpisode = /(-?)(e?)(\d+)/iuy;
const isBoundary = (stem: string, index: number): boolean =>
  index >= stem.length || /[^a-z\d]/iu.test(stem[index] ?? "");

interface EpisodeCoordinates {
  readonly season: number;
  readonly episode: number;
  /** Every episode named after the first, in order. */
  readonly following: ReadonlyArray<number>;
  /** Whether the episodes after the first start with a dash, as in "E10-11" or "E10-E11". */
  readonly dashed: boolean;
  /** Whether an episode number runs into letters, as in "E11-E12x". */
  readonly malformed: boolean;
  /** Where the coordinates end in the stem. */
  readonly end: number;
}

/**
 * "S03E10", optionally followed by more episodes: "-11", "-E11", "E11", "E11E12" or "-E11-E12".
 * Each number is taken whole, so "-E1000" or "-11-13" is judged as written rather than by a valid
 * start. A dashed number running into letters, such as "-1080p" or "-720p", is not an episode.
 */
const episodeCoordinates = (stem: string): EpisodeCoordinates | null => {
  for (const match of stem.matchAll(firstEpisode)) {
    const start = match.index + match[0].length;
    const following: number[] = [];
    let end = start;
    let malformed = false;
    for (;;) {
      laterEpisode.lastIndex = end;
      const token = laterEpisode.exec(stem);
      if (token === null || (token[1] === "" && token[2] === "")) break;
      const after = laterEpisode.lastIndex;
      // A chain continues straight into its next "E".
      const complete = isBoundary(stem, after) || /^e\d/iu.test(stem.slice(after, after + 2));
      if (!complete) {
        if (token[2] !== "") malformed = true;
        break;
      }
      following.push(Number(token[3]));
      end = after;
    }
    if (isBoundary(stem, end) || malformed)
      return {
        season: Number(match[1]),
        episode: Number(match[2]),
        following,
        dashed: stem[start] === "-",
        malformed,
        end: malformed ? stem.length : end,
      };
  }
  return null;
};

/**
 * The last episode coordinates cover, null for one episode, or "invalid" where more episodes are
 * named but do not form a range one file can hold. A single dashed number is an inclusive range
 * ("E10-E12" is 10 to 12); anything else lists every episode, which must then be consecutive
 * ("E10E11E12" or "E10-11-12", but not "E10E12", "E10-11-13" or "E10-E11-E1000").
 */
const episodeEnd = (coordinates: EpisodeCoordinates): number | null | "invalid" => {
  const { episode, following, dashed, malformed } = coordinates;
  if (malformed) return "invalid";
  const end = following.at(-1);
  if (end === undefined) return null;
  const listed = following.length > 1 || !dashed;
  if (listed && following.some((number, index) => number !== episode + index + 1)) return "invalid";
  return isEpisodeRange(episode, end) ? end : "invalid";
};

export const parseVideoPath = (kind: "movies" | "shows", relativePath: string): VideoPath => {
  const parts = relativePath.split(/[\\/]/u).filter(Boolean);
  const file = parts.at(-1) ?? "Untitled";
  const stem = basename(file, extname(file));
  if (kind === "movies") {
    const label = parts.length > 1 ? parts.at(-2) ?? stem : stem;
    return { kind: "movie", ...name(label), show: null, season: null, episodeNumber: null, episodeNumberEnd: null, warning: null };
  }
  const showPath = parts.length > 1 ? parts[0] ?? "" : "";
  const show = { path: showPath, ...name(showPath || "Unsorted") };
  const seasonLabel = parts.length > 2 ? parts[1] ?? "" : "";
  const seasonNumber = /^(?:season|series)\s*0*(\d+)$/iu.exec(seasonLabel)?.[1];
  const coordinates = episodeCoordinates(stem);
  const season = seasonNumber !== undefined
    ? { path: `${showPath}/${seasonLabel}`, number: Number(seasonNumber) }
    : coordinates !== null ? { path: `${showPath}/Season ${coordinates.season}`, number: coordinates.season } : null;
  const episodeNumber = coordinates?.episode ?? null;
  const end = coordinates === null ? null : episodeEnd(coordinates);
  const afterCoordinates = coordinates === null ? stem : stem.slice(coordinates.end);
  const episodeTitle = afterCoordinates.replace(/[._]+/gu, " ").replace(/^[\s-]+/u, "").trim();
  const warning = showPath === "" ? "show_folder_missing"
    : seasonNumber === undefined ? "season_folder_missing"
    : coordinates === null ? "episode_coordinates_missing"
    : coordinates.season !== Number(seasonNumber) ? "season_number_mismatch"
    : end === "invalid" ? "episode_range_invalid"
    : null;
  return {
    kind: "episode", title: episodeTitle || `Episode ${episodeNumber ?? stem}`, year: null,
    providerId: null, imdbId: null, show, season, episodeNumber,
    episodeNumberEnd: end === "invalid" ? null : end, warning,
  };
};
