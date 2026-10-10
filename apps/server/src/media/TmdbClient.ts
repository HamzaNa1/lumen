import { readResponseBytes } from "../core/BoundedInput";

export type TmdbObject = Record<string, unknown>;

export const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const object = (value: unknown): TmdbObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TmdbObject) : {};

/** Where TMDb serves an image, or null when the path is not one of its image paths. */
export const tmdbImageUrl = (size: "w92" | "w780", path: unknown): string | null =>
  typeof path === "string" && /^\/[a-zA-Z0-9._-]+$/u.test(path)
    ? `https://image.tmdb.org/t/p/${size}${path}`
    : null;

export class TmdbHttpError extends Error {
  constructor(readonly status: number) {
    super(`TMDb returned ${status}`);
  }
}

export const fetchTmdb = async (path: string, key: string): Promise<TmdbObject> => {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", key);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new TmdbHttpError(response.status);
  const result: unknown = JSON.parse(
    new TextDecoder().decode(await readResponseBytes(response, 2_000_000)),
  );
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error("TMDb returned invalid metadata");
  return result as TmdbObject;
};
