import { readResponseBytes } from "./BoundedInput";

export type TmdbObject = Record<string, unknown>;

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
