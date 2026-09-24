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

export const parseVideoPath = (kind: "movies" | "shows", relativePath: string): VideoPath => {
  const parts = relativePath.split(/[\\/]/u).filter(Boolean);
  const file = parts.at(-1) ?? "Untitled";
  const stem = basename(file, extname(file));
  if (kind === "movies") {
    const label = parts.length > 1 ? parts.at(-2) ?? stem : stem;
    return { kind: "movie", ...name(label), show: null, season: null, episodeNumber: null, warning: null };
  }
  const showPath = parts.length > 1 ? parts[0] ?? "" : "";
  const show = { path: showPath, ...name(showPath || "Unsorted") };
  const seasonLabel = parts.length > 2 ? parts[1] ?? "" : "";
  const seasonNumber = /^(?:season|series)\s*0*(\d+)$/iu.exec(seasonLabel)?.[1];
  const coordinates = /(?:^|[^a-z\d])s(\d{1,2})e(\d{1,3})(?:[^a-z\d]|$)/iu.exec(stem);
  const season = seasonNumber !== undefined
    ? { path: `${showPath}/${seasonLabel}`, number: Number(seasonNumber) }
    : coordinates !== null ? { path: `${showPath}/Season ${Number(coordinates[1])}`, number: Number(coordinates[1]) } : null;
  const episodeNumber = coordinates === null ? null : Number(coordinates[2]);
  const episodeTitle = stem.replace(/.*?s\d{1,2}e\d{1,3}[\s._-]*/iu, "").replace(/[._]+/gu, " ").trim();
  const warning = showPath === "" ? "show_folder_missing"
    : seasonNumber === undefined ? "season_folder_missing"
    : coordinates === null ? "episode_coordinates_missing"
    : Number(coordinates[1]) !== Number(seasonNumber) ? "season_number_mismatch"
    : null;
  return {
    kind: "episode", title: episodeTitle || `Episode ${episodeNumber ?? stem}`, year: null,
    providerId: null, imdbId: null, show, season, episodeNumber, warning,
  };
};
