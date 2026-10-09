import type { MetadataMatchCandidate } from "@lumen/contracts";
import { readResponseBytes } from "./BoundedInput";
import { imageInfo } from "./ImageInfo";
import {
  fetchTmdb,
  num,
  object,
  str,
  TmdbHttpError,
  tmdbImageUrl,
  type TmdbObject,
} from "./TmdbClient";

type TitleKind = "movie" | "tv";

const maxCandidates = 12;

const title = async (kind: TitleKind, tmdbId: string, key: string): Promise<TmdbObject | null> => {
  // TMDb IDs are 32-bit; anything longer is a typo, not an outage.
  if (!/^\d{1,9}$/u.test(tmdbId)) return null;
  try {
    return await fetchTmdb(`/${kind}/${tmdbId}`, key);
  } catch (cause) {
    if (cause instanceof TmdbHttpError && cause.status === 404) return null;
    throw cause;
  }
};

/** A thumbnail the client can show without contacting TMDb; a candidate is still usable without one. */
const posterUrl = async (path: unknown): Promise<string | null> => {
  const url = tmdbImageUrl("w92", path);
  if (url === null) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const bytes = await readResponseBytes(response, 200_000);
    const image = imageInfo(bytes);
    return image === null
      ? null
      : `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
};

const candidate = async (row: TmdbObject, id: unknown): Promise<MetadataMatchCandidate | null> => {
  const name = str(row.title ?? row.name);
  const tmdbId = typeof id === "string" ? id : String(num(id));
  if (name === null || !/^\d+$/u.test(tmdbId)) return null;
  const year = Number(str(row.release_date ?? row.first_air_date)?.slice(0, 4));
  return {
    tmdbId,
    title: name,
    year: Number.isInteger(year) && year > 0 ? year : null,
    overview: str(row.overview) ?? "",
    posterUrl: await posterUrl(row.poster_path),
  };
};

export const tmdbTitleExists = async (
  kind: TitleKind,
  tmdbId: string,
  key: string,
): Promise<boolean> => (await title(kind, tmdbId, key)) !== null;

/** Titles matching a search, led by the title whose ID is the search when it is a number. */
export const tmdbMatchCandidates = async (
  kind: TitleKind,
  query: string,
  key: string,
): Promise<ReadonlyArray<MetadataMatchCandidate>> => {
  const [identified, search] = await Promise.all([
    title(kind, query, key),
    fetchTmdb(`/search/${kind}?${new URLSearchParams({ query })}`, key),
  ]);
  const rows = (Array.isArray(search.results) ? search.results : []).map(object);
  const found = await Promise.all([
    identified === null ? null : candidate(identified, query),
    ...rows.slice(0, maxCandidates).map((row) => candidate(row, row.id)),
  ]);
  const candidates = new Map<string, MetadataMatchCandidate>();
  for (const entry of found)
    if (entry !== null && !candidates.has(entry.tmdbId)) candidates.set(entry.tmdbId, entry);
  return [...candidates.values()].slice(0, maxCandidates);
};
