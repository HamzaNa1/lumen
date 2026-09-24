import { Database, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../config/Config";
import { newUuid } from "../core/Security";
import { readResponseBytes } from "./BoundedInput";
import { imageInfo } from "./ImageInfo";
import { MetadataSettings } from "../services/MetadataSettings";

type TmdbObject = Record<string, unknown>;
type Item = { id: string; kind: string; parentId: string | null; title: string; year: number | null; indexNumber: number | null; origin: string | null };

export interface MetadataProvider {
  readonly enrichSource: (sourceId: string) => Effect.Effect<void, unknown>;
}

const titleKey = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const names = (value: unknown): string[] => Array.isArray(value) ? value.map((entry) => entry && typeof entry === "object" ? str((entry as TmdbObject).name) : null).filter((entry): entry is string => entry !== null) : [];
const object = (value: unknown): TmdbObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as TmdbObject : {};
const remoteContentRating = (payload: TmdbObject): string | null => {
  const movie = object(payload.release_dates).results;
  if (Array.isArray(movie)) {
    const us = movie.map(object).find((entry) => entry.iso_3166_1 === "US");
    const rating = Array.isArray(us?.release_dates) ? us.release_dates.map(object).map((entry) => str(entry.certification)).find((entry) => entry !== null) : null;
    if (rating) return rating;
  }
  const tv = object(payload.content_ratings).results;
  if (Array.isArray(tv)) return str(tv.map(object).find((entry) => entry.iso_3166_1 === "US")?.rating);
  return null;
};
const fetchTmdb = async (path: string, key: string): Promise<TmdbObject> => {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`TMDb returned ${response.status}`);
  const result: unknown = JSON.parse(new TextDecoder().decode(await readResponseBytes(response, 2_000_000)));
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("TMDb returned invalid metadata");
  return result as TmdbObject;
};

const lookup = async (item: Item, parentProviderId: string | null, key: string, explicit: string | null, imdbId: string | null): Promise<{ id: string; payload: TmdbObject; confidence: number } | null> => {
  if (item.kind === "movie" || item.kind === "show") {
    const kind = item.kind === "movie" ? "movie" : "tv";
    let id = explicit;
    let confidence = 100;
    if (id === null && imdbId !== null && /^tt\d+$/u.test(imdbId)) {
      const found = await fetchTmdb(`/find/${imdbId}?external_source=imdb_id`, key);
      const results = found[item.kind === "movie" ? "movie_results" : "tv_results"];
      if (!Array.isArray(results) || results.length !== 1 || num(object(results[0]).id) === null) return null;
      id = String(object(results[0]).id);
      confidence = 100;
    }
    if (id === null) {
      const query = new URLSearchParams({ query: item.title });
      if (item.year !== null) query.set(item.kind === "movie" ? "year" : "first_air_date_year", String(item.year));
      const results = await fetchTmdb(`/search/${kind}?${query}`, key);
      const matches = (Array.isArray(results.results) ? results.results : []).filter((candidate): candidate is TmdbObject => {
        if (candidate === null || typeof candidate !== "object") return false;
        const row = candidate as TmdbObject;
        const name = str(row.title ?? row.name);
        const year = Number(str(row.release_date ?? row.first_air_date)?.slice(0, 4));
        return name !== null && titleKey(name) === titleKey(item.title) && (item.year === null || year === item.year);
      });
      if (matches.length !== 1 || num(matches[0]?.id) === null) return null;
      id = String(matches[0]?.id);
      confidence = 90;
    }
    if (!/^\d+$/u.test(id)) return null;
    return { id, payload: await fetchTmdb(`/${kind}/${id}?append_to_response=${kind === "movie" ? "release_dates,keywords,external_ids,images" : "content_ratings,keywords,external_ids,images"}`, key), confidence };
  }
  if (parentProviderId === null || item.indexNumber === null) return null;
  const seasonId = item.kind === "season" ? item.indexNumber : Number(parentProviderId.split(":")[1]);
  if (!Number.isInteger(seasonId)) return null;
  const path = item.kind === "season" ? `/tv/${parentProviderId}/season/${seasonId}` : `/tv/${parentProviderId.split(":")[0]}/season/${seasonId}/episode/${item.indexNumber}`;
  return { id: `${parentProviderId}:${item.indexNumber}`, payload: await fetchTmdb(path, key), confidence: 95 };
};

export const makeTmdbProvider = (config: ServerConfig) => Effect.gen(function* () {
  const database = yield* Database;
  const settings = yield* MetadataSettings;
  const enrichSource: MetadataProvider["enrichSource"] = Effect.fn("Tmdb.enrichSource")(function* (sourceId) {
    const apiKey = yield* settings.tmdbKey();
    if (apiKey === null) return;
    const file = yield* database.get<{ id: string; parentId: string | null }>(sql`
      SELECT i.id, i.parent_id AS parentId FROM catalog_items i JOIN catalog_item_sources s ON s.item_id = i.id
      WHERE s.source_id = ${sourceId} LIMIT 1
    `);
    if (file == null) return;
    const ids: string[] = [];
    let current: string | null = file.id;
    while (current !== null) {
      ids.unshift(current);
      current = (yield* database.get<{ parentId: string | null }>(sql`SELECT parent_id AS parentId FROM catalog_items WHERE id = ${current}`))?.parentId ?? null;
    }
    let parentProviderId: string | null = null;
    for (const itemId of ids) {
      const item = yield* database.get<Item>(sql`
        SELECT i.id, i.kind, i.parent_id AS parentId, i.title, i.year, i.index_number AS indexNumber, o.relative_path AS origin
        FROM catalog_items i LEFT JOIN catalog_item_origins o ON o.item_id = i.id WHERE i.id = ${itemId}
      `);
      if (item == null) continue;
      const old = yield* database.get<{ externalIdsJson: string; fieldSourcesJson: string; lockedFieldsJson: string; releaseDate: string | null; contentRating: string | null; communityRating: number | null; genresJson: string; studiosJson: string; tagsJson: string; title: string; overview: string | null; year: number | null }>(sql`
        SELECT m.external_ids_json AS externalIdsJson, m.field_sources_json AS fieldSourcesJson, m.locked_fields_json AS lockedFieldsJson,
          m.release_date AS releaseDate, m.content_rating AS contentRating, m.community_rating AS communityRating,
          m.genres_json AS genresJson, m.studios_json AS studiosJson, m.tags_json AS tagsJson,
          i.title, i.overview, i.year FROM catalog_items i LEFT JOIN catalog_item_metadata m ON m.item_id = i.id WHERE i.id = ${itemId}
      `);
      const externalIds = JSON.parse(old?.externalIdsJson ?? "{}") as Record<string, string>;
      const explicit = externalIds.tmdb ?? /\[(?:tmdbid|tmdb)-(\d+)\]/iu.exec(item.origin ?? "")?.[1] ?? null;
      const imdbId = externalIds.imdb ?? /\[(?:imdbid|imdb)-(tt\d+)\]/iu.exec(item.origin ?? "")?.[1] ?? null;
      const result = yield* Effect.tryPromise({ try: () => lookup(item, parentProviderId, apiKey, explicit, imdbId), catch: (cause) => cause });
      if (result === null) return;
      parentProviderId = result.id;
      const payload = result.payload;
      const locks = new Set(JSON.parse(old?.lockedFieldsJson ?? "[]") as string[]);
      const sources = JSON.parse(old?.fieldSourcesJson ?? "{}") as Record<string, string>;
      const take = <T>(field: string, remote: T | null, existing: T | null): T | null => {
        if (remote === null || locks.has(field) || sources[field] === "nfo" || sources[field] === "user") return existing;
        sources[field] = "tmdb";
        return remote;
      };
      const title = take("title", str(payload.title ?? payload.name), old?.title ?? null) ?? item.title;
      const overview = take("overview", str(payload.overview), old?.overview ?? null);
      const releaseDate = take("releaseDate", str(payload.release_date ?? payload.first_air_date ?? payload.air_date), old?.releaseDate ?? null);
      const remoteYear = Number(releaseDate?.slice(0, 4));
      const year = take("year", Number.isInteger(remoteYear) && remoteYear >= 1800 ? remoteYear : null, old?.year ?? null);
      const communityRating = take("communityRating", num(payload.vote_average), old?.communityRating ?? null);
      const contentRating = take("contentRating", remoteContentRating(payload), old?.contentRating ?? null);
      const genres = take("genres", names(payload.genres), JSON.parse(old?.genresJson ?? "[]") as string[]) ?? [];
      const studios = take("studios", names(payload.production_companies ?? payload.networks), JSON.parse(old?.studiosJson ?? "[]") as string[]) ?? [];
      const keywords = object(payload.keywords);
      const tags = take("tags", names(keywords.keywords ?? keywords.results), JSON.parse(old?.tagsJson ?? "[]") as string[]) ?? [];
      const remoteIds = object(payload.external_ids);
      const ids: Record<string, string> = { ...externalIds, tmdb: result.id };
      if (imdbId !== null) ids.imdb = imdbId;
      for (const [key, value] of Object.entries(remoteIds)) if (typeof value === "string" && value) ids[key] = value;
      yield* database.run(sql`
        INSERT INTO provider_records(id, item_id, provider, provider_item_id, payload_json, confidence, fetched_at_ms, locked_fields_json)
        VALUES (${newUuid()}, ${itemId}, 'tmdb', ${result.id}, ${JSON.stringify(payload)}, ${result.confidence}, unixepoch() * 1000, '[]')
        ON CONFLICT(item_id, provider, provider_item_id) DO UPDATE SET payload_json = excluded.payload_json,
          confidence = excluded.confidence, fetched_at_ms = excluded.fetched_at_ms
      `);
      yield* database.run(sql`UPDATE catalog_items SET title = ${title}, sort_title = ${title.toLowerCase()}, overview = ${overview}, year = ${year}, metadata_state = 'tmdb', updated_at_ms = unixepoch() * 1000 WHERE id = ${itemId}`);
      yield* database.run(sql`
        INSERT INTO catalog_item_metadata(item_id, release_date, content_rating, community_rating, genres_json, studios_json, tags_json, external_ids_json, field_sources_json)
        VALUES (${itemId}, ${releaseDate}, ${contentRating}, ${communityRating}, ${JSON.stringify(genres)}, ${JSON.stringify(studios)}, ${JSON.stringify(tags)}, ${JSON.stringify(ids)}, ${JSON.stringify(sources)})
        ON CONFLICT(item_id) DO UPDATE SET release_date = excluded.release_date, community_rating = excluded.community_rating,
          content_rating = excluded.content_rating, genres_json = excluded.genres_json, studios_json = excluded.studios_json,
          tags_json = excluded.tags_json, external_ids_json = excluded.external_ids_json,
          field_sources_json = excluded.field_sources_json
      `);
      const logos = object(payload.images).logos;
      const logoPath = Array.isArray(logos) ? object(logos[0]).file_path : null;
      for (const [role, imagePath] of [["poster", payload.poster_path], ["backdrop", payload.backdrop_path], ["logo", logoPath], ["still", payload.still_path]] as const) {
        if (item.kind === "episode" && role !== "still") continue;
        if (item.kind !== "episode" && role === "still") continue;
        if (typeof imagePath !== "string" || !/^\/[a-zA-Z0-9._-]+$/u.test(imagePath)) continue;
        const assigned = yield* database.get<{ source: string }>(sql`SELECT source FROM catalog_item_artwork WHERE item_id = ${itemId} AND role = ${role}`);
        if (assigned != null && assigned.source !== "tmdb") continue;
        const response = yield* Effect.tryPromise({ try: () => fetch(`https://image.tmdb.org/t/p/w780${imagePath}`, { signal: AbortSignal.timeout(10_000) }), catch: (cause) => cause });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 20_000_000) continue;
        const bytes = yield* Effect.tryPromise({ try: () => readResponseBytes(response, 20_000_000), catch: (cause) => cause });
        const image = imageInfo(bytes);
        if (image === null || image.width < 1 || image.height < 1) continue;
        const mime = image.mimeType;
        const hash = createHash("sha256").update(bytes).digest("hex");
        const path = join(config.dataDir, "artwork", `${hash}.${mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp"}`);
        yield* Effect.promise(() => mkdir(join(config.dataDir, "artwork"), { recursive: true }));
        yield* Effect.tryPromise({ try: async () => {
          try { await writeFile(path, bytes, { flag: "wx" }); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
        }, catch: (cause) => cause });
        const artworkId = newUuid();
        yield* database.run(sql`
          INSERT INTO artwork(id, library_id, source_id, kind, mime_type, width, height, byte_size, content_hash, relative_path, created_at_ms)
          VALUES (${artworkId}, (SELECT library_id FROM catalog_items WHERE id = ${itemId}), NULL, 'other', ${mime}, ${image.width}, ${image.height}, ${bytes.length}, ${hash}, ${path}, unixepoch() * 1000)
          ON CONFLICT DO NOTHING
        `);
        const stored = yield* database.get<{ id: string }>(sql`
          SELECT id FROM artwork WHERE library_id = (SELECT library_id FROM catalog_items WHERE id = ${itemId})
            AND (relative_path = ${path} OR (content_hash = ${hash} AND kind = 'other')) LIMIT 1
        `);
        if (stored != null) yield* database.run(sql`
          INSERT INTO catalog_item_artwork(item_id, role, artwork_id, source) VALUES (${itemId}, ${role}, ${stored.id}, 'tmdb')
          ON CONFLICT(item_id, role) DO UPDATE SET artwork_id = excluded.artwork_id
        `);
      }
    }
  });
  return { enrichSource };
});

export class TmdbProvider extends Context.Service<TmdbProvider, MetadataProvider>()("@lumen/server/Tmdb") {}
export const TmdbProviderLive = (config: ServerConfig) => Layer.effect(TmdbProvider, makeTmdbProvider(config));
