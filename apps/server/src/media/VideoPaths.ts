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

// "S03E10", optionally followed by more episodes: "-11", "-E11", "E11", "E11E12" or "-E11-E12".
// Every following episode number is taken, so a malformed continuation such as "-11-13" is
// judged as a whole rather than as its valid start. The lookahead keeps "-1080p" or "-720p"
// from reading as an episode.
const episodeCoordinates = /(?:^|[^a-z\d])s(\d{1,2})e(\d{1,3})((?:-e?\d{1,3}|e\d{1,3})+)?(?=[^a-z\d]|$)/iu;

/**
 * The last episode a file's coordinates cover, null for one episode, or "invalid" where more
 * episodes are named but do not form a range one file can hold. A single dashed number is an
 * inclusive range ("E10-E12" is 10 to 12); anything else lists every episode, which must then be
 * consecutive ("E10E11E12" or "E10-11-12", but not "E10E12" or "E10-11-13").
 */
const episodeEnd = (start: number, suffix: string | undefined): number | null | "invalid" => {
  if (suffix === undefined) return null;
  const numbers = [...suffix.matchAll(/\d+/gu)].map((match) => Number(match[0]));
  const listed = numbers.length > 1 || !suffix.startsWith("-");
  const end = numbers.at(-1) ?? start;
  if (listed && numbers.some((number, index) => number !== start + index + 1)) return "invalid";
  return isEpisodeRange(start, end) ? end : "invalid";
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
  const coordinates = episodeCoordinates.exec(stem);
  const season = seasonNumber !== undefined
    ? { path: `${showPath}/${seasonLabel}`, number: Number(seasonNumber) }
    : coordinates !== null ? { path: `${showPath}/Season ${Number(coordinates[1])}`, number: Number(coordinates[1]) } : null;
  const episodeNumber = coordinates === null ? null : Number(coordinates[2]);
  const end = episodeNumber === null ? null : episodeEnd(episodeNumber, coordinates?.[3]);
  const afterCoordinates = coordinates === null ? stem : stem.slice(coordinates.index + coordinates[0].length);
  const episodeTitle = afterCoordinates.replace(/[._]+/gu, " ").replace(/^[\s-]+/u, "").trim();
  const warning = showPath === "" ? "show_folder_missing"
    : seasonNumber === undefined ? "season_folder_missing"
    : coordinates === null ? "episode_coordinates_missing"
    : Number(coordinates[1]) !== Number(seasonNumber) ? "season_number_mismatch"
    : end === "invalid" ? "episode_range_invalid"
    : null;
  return {
    kind: "episode", title: episodeTitle || `Episode ${episodeNumber ?? stem}`, year: null,
    providerId: null, imdbId: null, show, season, episodeNumber,
    episodeNumberEnd: end === "invalid" ? null : end, warning,
  };
};
