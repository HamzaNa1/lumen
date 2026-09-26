import {
  artwork as artworkTable,
  catalogItemArtwork,
  catalogItemMetadata,
  catalogItemOrigins,
  catalogItems,
  catalogItemSources,
  Database,
  providerRecords,
  Repositories,
  seriesEpisodeOrders,
} from "@lumen/database";
import type { EpisodeOrderOptions, EpisodeOrderSelection } from "@lumen/contracts";
import { badRequest, ServerError } from "../core/Errors";
import { and, eq, inArray, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../config/Config";
import { newUuid } from "../core/Security";
import { readResponseBytes } from "./BoundedInput";
import { generatedArtworkDir } from "./GeneratedArtwork";
import { imageInfo } from "./ImageInfo";
import { MetadataSettings } from "../services/MetadataSettings";
import { decodeMetadataList, decodeMetadataMap } from "./MetadataJson";
import { fetchTmdb, TmdbHttpError, type TmdbObject } from "./TmdbClient";
import { tmdbEpisodeCoordinates, tmdbEpisodeOrders } from "./TmdbEpisodeOrder";

type Item = {
  id: string;
  libraryId: string;
  kind: string;
  parentId: string | null;
  title: string;
  year: number | null;
  indexNumber: number | null;
  origin: string | null;
};

export interface MetadataProvider {
  readonly episodeOrder: (itemId: string) => Effect.Effect<EpisodeOrderOptions, unknown>;
  readonly setEpisodeOrder: (
    itemId: string,
    selection: EpisodeOrderSelection,
  ) => Effect.Effect<void, unknown>;
  readonly enrichSource: (sourceId: string) => Effect.Effect<void, unknown>;
}

const titleKey = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object" ? str((entry as TmdbObject).name) : null,
        )
        .filter((entry): entry is string => entry !== null)
    : [];
const object = (value: unknown): TmdbObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TmdbObject) : {};
const remoteContentRating = (payload: TmdbObject): string | null => {
  const movie = object(payload.release_dates).results;
  if (Array.isArray(movie)) {
    const us = movie.map(object).find((entry) => entry.iso_3166_1 === "US");
    const rating = Array.isArray(us?.release_dates)
      ? us.release_dates
          .map(object)
          .map((entry) => str(entry.certification))
          .find((entry) => entry !== null)
      : null;
    if (rating) return rating;
  }
  const tv = object(payload.content_ratings).results;
  if (Array.isArray(tv))
    return str(tv.map(object).find((entry) => entry.iso_3166_1 === "US")?.rating);
  return null;
};
const providerIds = (externalIds: Record<string, string>, origin: string | null) => ({
  tmdbId: externalIds.tmdb ?? /\[(?:tmdbid|tmdb)-(\d+)\]/iu.exec(origin ?? "")?.[1] ?? null,
  imdbId: externalIds.imdb ?? /\[(?:imdbid|imdb)-(tt\d+)\]/iu.exec(origin ?? "")?.[1] ?? null,
});
const lookup = async (
  item: Item,
  parentProviderId: string | null,
  key: string,
  explicit: string | null,
  imdbId: string | null,
  episodeGroupId: string | null = null,
): Promise<{ id: string; payload: TmdbObject | null; confidence: number } | null> => {
  if (item.kind === "movie" || item.kind === "show") {
    const kind = item.kind === "movie" ? "movie" : "tv";
    let id = explicit;
    let confidence = 100;
    if (id === null && imdbId !== null && /^tt\d+$/u.test(imdbId)) {
      const found = await fetchTmdb(`/find/${imdbId}?external_source=imdb_id`, key);
      const results = found[item.kind === "movie" ? "movie_results" : "tv_results"];
      if (!Array.isArray(results) || results.length !== 1 || num(object(results[0]).id) === null)
        return null;
      id = String(object(results[0]).id);
      confidence = 100;
    }
    if (id === null) {
      const query = new URLSearchParams({ query: item.title });
      if (item.year !== null)
        query.set(item.kind === "movie" ? "year" : "first_air_date_year", String(item.year));
      const results = await fetchTmdb(`/search/${kind}?${query}`, key);
      const matches = (Array.isArray(results.results) ? results.results : []).filter(
        (candidate): candidate is TmdbObject => {
          if (candidate === null || typeof candidate !== "object") return false;
          const row = candidate as TmdbObject;
          const name = str(row.title ?? row.name);
          const year = Number(str(row.release_date ?? row.first_air_date)?.slice(0, 4));
          return (
            name !== null &&
            titleKey(name) === titleKey(item.title) &&
            (item.year === null || year === item.year)
          );
        },
      );
      if (matches.length !== 1 || num(matches[0]?.id) === null) return null;
      id = String(matches[0]?.id);
      confidence = 90;
    }
    if (!/^\d+$/u.test(id)) return null;
    return {
      id,
      payload: await fetchTmdb(
        `/${kind}/${id}?append_to_response=${kind === "movie" ? "release_dates,keywords,external_ids,images" : "content_ratings,keywords,external_ids,images"}`,
        key,
      ),
      confidence,
    };
  }
  if (parentProviderId === null || item.indexNumber === null) return null;
  let seasonId = item.kind === "season" ? item.indexNumber : Number(parentProviderId.split(":")[1]);
  if (!Number.isInteger(seasonId)) return null;
  let episodeNumber = item.indexNumber;
  if (item.kind === "season" && episodeGroupId !== null)
    return { id: `${parentProviderId}:${seasonId}`, payload: null, confidence: 95 };
  if (item.kind === "episode" && episodeGroupId !== null) {
    const coordinates = await tmdbEpisodeCoordinates(episodeGroupId, seasonId, episodeNumber, key);
    seasonId = coordinates.seasonNumber;
    episodeNumber = coordinates.episodeNumber;
  }
  const path =
    item.kind === "season"
      ? `/tv/${parentProviderId}/season/${seasonId}`
      : `/tv/${parentProviderId.split(":")[0]}/season/${seasonId}/episode/${episodeNumber}`;
  let payload: TmdbObject | null;
  try {
    payload = await fetchTmdb(path, key);
  } catch (cause) {
    if (item.kind !== "season" || !(cause instanceof TmdbHttpError) || cause.status !== 404)
      throw cause;
    // The local season remains usable even when TMDb has no season metadata.
    payload = null;
  }
  return {
    id:
      item.kind === "season"
        ? `${parentProviderId}:${seasonId}`
        : `${parentProviderId.split(":")[0]}:${seasonId}:${episodeNumber}`,
    payload,
    confidence: 95,
  };
};

export const makeTmdbProvider = (config: ServerConfig) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const settings = yield* MetadataSettings;
    const repositories = yield* Repositories;
    const episodeOrder: MetadataProvider["episodeOrder"] = Effect.fn("Tmdb.episodeOrder")(
      function* (itemId) {
        const item = yield* database
          .select({
            id: catalogItems.id,
            libraryId: catalogItems.libraryId,
            kind: catalogItems.kind,
            parentId: catalogItems.parentId,
            title: catalogItems.title,
            year: catalogItems.year,
            indexNumber: catalogItems.indexNumber,
            origin: catalogItemOrigins.relativePath,
            externalIdsJson: catalogItemMetadata.externalIdsJson,
          })
          .from(catalogItems)
          .leftJoin(catalogItemOrigins, eq(catalogItemOrigins.itemId, catalogItems.id))
          .leftJoin(catalogItemMetadata, eq(catalogItemMetadata.itemId, catalogItems.id))
          .where(eq(catalogItems.id, itemId))
          .get();
        if (item === undefined || item.kind !== "show") return yield* badRequest("Choose a series");
        const key = yield* settings.tmdbKey();
        if (key === null)
          return yield* badRequest("Configure TMDb before choosing an episode order");
        const { tmdbId, imdbId } = providerIds(
          decodeMetadataMap(item.externalIdsJson),
          item.origin,
        );
        const saved = yield* database
          .select()
          .from(seriesEpisodeOrders)
          .where(eq(seriesEpisodeOrders.itemId, itemId))
          .get();
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await lookup(item, null, key, tmdbId, imdbId);
            if (result === null)
              throw badRequest("Match this series before choosing an episode order");
            return tmdbEpisodeOrders(
              result.id,
              saved?.tmdbSeriesId === result.id ? saved.groupId : null,
              key,
            );
          },
          catch: (cause) =>
            cause instanceof ServerError
              ? cause
              : new ServerError({
                  status: 503,
                  code: "service_unavailable",
                  message: "Could not load episode orders from TMDb. Try again.",
                  cause,
                }),
        });
      },
    );
    const setEpisodeOrder: MetadataProvider["setEpisodeOrder"] = Effect.fn("Tmdb.setEpisodeOrder")(
      function* (itemId, selection) {
        const options = yield* episodeOrder(itemId);
        if (selection.tmdbSeriesId !== options.tmdbSeriesId)
          return yield* badRequest("The series match changed. Reload its episode orders.");
        if (
          selection.groupId !== null &&
          !options.groups.some((group) => group.id === selection.groupId)
        )
          return yield* badRequest("Choose an episode order belonging to this series");
        const descendants = yield* repositories.catalog.descendantItemIds(itemId);
        yield* database.transaction((transaction) =>
          Effect.gen(function* () {
            const metadata = yield* transaction
              .select()
              .from(catalogItemMetadata)
              .where(eq(catalogItemMetadata.itemId, itemId))
              .get();
            const ids = decodeMetadataMap(metadata?.externalIdsJson ?? null);
            if (ids.tmdb !== undefined && ids.tmdb !== selection.tmdbSeriesId)
              return yield* badRequest("The series match changed. Reload its episode orders.");
            const values = {
              itemId,
              externalIdsJson: JSON.stringify({ ...ids, tmdb: selection.tmdbSeriesId }),
            };
            yield* transaction.insert(catalogItemMetadata).values(values).onConflictDoUpdate({
              target: catalogItemMetadata.itemId,
              set: values,
            });
            if (selection.groupId === null)
              yield* transaction
                .delete(seriesEpisodeOrders)
                .where(eq(seriesEpisodeOrders.itemId, itemId));
            else
              yield* transaction
                .insert(seriesEpisodeOrders)
                .values({ itemId, ...selection, groupId: selection.groupId })
                .onConflictDoUpdate({
                  target: seriesEpisodeOrders.itemId,
                  set: { tmdbSeriesId: selection.tmdbSeriesId, groupId: selection.groupId },
                });
            yield* transaction
              .delete(providerRecords)
              .where(
                and(
                  inArray(providerRecords.itemId, descendants),
                  eq(providerRecords.provider, "tmdb"),
                ),
              );
          }),
        );
      },
    );
    const enrichSource: MetadataProvider["enrichSource"] = Effect.fn("Tmdb.enrichSource")(
      function* (sourceId) {
        const apiKey = yield* settings.tmdbKey();
        if (apiKey === null) return;
        const file = yield* database
          .select({ id: catalogItems.id, parentId: catalogItems.parentId })
          .from(catalogItems)
          .innerJoin(catalogItemSources, eq(catalogItemSources.itemId, catalogItems.id))
          .where(eq(catalogItemSources.sourceId, sourceId))
          .limit(1)
          .get();
        if (file == null) return;
        const ids: string[] = [];
        let current: string | null = file.id;
        while (current !== null) {
          ids.unshift(current);
          current =
            (yield* database
              .select({ parentId: catalogItems.parentId })
              .from(catalogItems)
              .where(eq(catalogItems.id, current))
              .get())?.parentId ?? null;
        }
        let parentProviderId: string | null = null;
        let episodeGroupId: string | null = null;
        for (const itemId of ids) {
          const item = (yield* database
            .select({
              id: catalogItems.id,
              libraryId: catalogItems.libraryId,
              kind: catalogItems.kind,
              parentId: catalogItems.parentId,
              title: catalogItems.title,
              year: catalogItems.year,
              indexNumber: catalogItems.indexNumber,
              origin: catalogItemOrigins.relativePath,
            })
            .from(catalogItems)
            .leftJoin(catalogItemOrigins, eq(catalogItemOrigins.itemId, catalogItems.id))
            .where(eq(catalogItems.id, itemId))
            .get()) as Item | undefined;
          if (item == null) continue;
          const old = yield* database
            .select({
              externalIdsJson: catalogItemMetadata.externalIdsJson,
              fieldSourcesJson: catalogItemMetadata.fieldSourcesJson,
              lockedFieldsJson: catalogItemMetadata.lockedFieldsJson,
              releaseDate: catalogItemMetadata.releaseDate,
              contentRating: catalogItemMetadata.contentRating,
              communityRating: catalogItemMetadata.communityRating,
              genresJson: catalogItemMetadata.genresJson,
              studiosJson: catalogItemMetadata.studiosJson,
              tagsJson: catalogItemMetadata.tagsJson,
              title: catalogItems.title,
              overview: catalogItems.overview,
              year: catalogItems.year,
            })
            .from(catalogItems)
            .leftJoin(catalogItemMetadata, eq(catalogItemMetadata.itemId, catalogItems.id))
            .where(eq(catalogItems.id, itemId))
            .get();
          const externalIds = decodeMetadataMap(old?.externalIdsJson ?? null);
          const { tmdbId, imdbId } = providerIds(externalIds, item.origin);
          const result = yield* Effect.tryPromise({
            try: () => lookup(item, parentProviderId, apiKey, tmdbId, imdbId, episodeGroupId),
            catch: (cause) => cause,
          });
          if (result === null) return;
          parentProviderId = result.id;
          if (item.kind === "show") {
            const order = yield* database
              .select()
              .from(seriesEpisodeOrders)
              .where(eq(seriesEpisodeOrders.itemId, item.id))
              .get();
            if (order !== undefined && order.tmdbSeriesId !== result.id)
              throw new Error("The series match changed. Choose its episode order again.");
            episodeGroupId = order?.groupId ?? null;
          }
          const payload = result.payload;
          if (payload === null) continue;
          const locks = new Set(decodeMetadataList(old?.lockedFieldsJson ?? null));
          const sources = decodeMetadataMap(old?.fieldSourcesJson ?? null);
          const take = <T>(field: string, remote: T | null, existing: T | null): T | null => {
            if (
              remote === null ||
              locks.has(field) ||
              sources[field] === "nfo" ||
              sources[field] === "user"
            )
              return existing;
            sources[field] = "tmdb";
            return remote;
          };
          const title =
            take("title", str(payload.title ?? payload.name), old?.title ?? null) ?? item.title;
          const overview = take("overview", str(payload.overview), old?.overview ?? null);
          const releaseDate = take(
            "releaseDate",
            str(payload.release_date ?? payload.first_air_date ?? payload.air_date),
            old?.releaseDate ?? null,
          );
          const remoteYear = Number(releaseDate?.slice(0, 4));
          const year = take(
            "year",
            Number.isInteger(remoteYear) && remoteYear >= 1800 ? remoteYear : null,
            old?.year ?? null,
          );
          const communityRating = take(
            "communityRating",
            num(payload.vote_average),
            old?.communityRating ?? null,
          );
          const contentRating = take(
            "contentRating",
            remoteContentRating(payload),
            old?.contentRating ?? null,
          );
          const genres =
            take("genres", names(payload.genres), decodeMetadataList(old?.genresJson ?? null)) ??
            [];
          const studios =
            take(
              "studios",
              names(payload.production_companies ?? payload.networks),
              decodeMetadataList(old?.studiosJson ?? null),
            ) ?? [];
          const keywords = object(payload.keywords);
          const tags =
            take(
              "tags",
              names(keywords.keywords ?? keywords.results),
              decodeMetadataList(old?.tagsJson ?? null),
            ) ?? [];
          const remoteIds = object(payload.external_ids);
          const ids: Record<string, string> = { ...externalIds, tmdb: result.id };
          if (imdbId !== null) ids.imdb = imdbId;
          for (const [key, value] of Object.entries(remoteIds))
            if (typeof value === "string" && value) ids[key] = value;
          const fetchedAtMs = Date.now();
          yield* database
            .insert(providerRecords)
            .values({
              id: newUuid(),
              itemId,
              provider: "tmdb",
              providerItemId: result.id,
              payloadJson: JSON.stringify(payload),
              confidence: result.confidence,
              fetchedAtMs,
              lockedFieldsJson: "[]",
            })
            .onConflictDoUpdate({
              target: [
                providerRecords.itemId,
                providerRecords.provider,
                providerRecords.providerItemId,
              ],
              set: {
                payloadJson: JSON.stringify(payload),
                confidence: result.confidence,
                fetchedAtMs,
              },
            });
          yield* database
            .update(catalogItems)
            .set({
              title,
              sortTitle: title.toLowerCase(),
              overview,
              year,
              metadataState: "tmdb",
              updatedAtMs: fetchedAtMs,
            })
            .where(eq(catalogItems.id, itemId));
          const metadata = {
            itemId,
            releaseDate,
            contentRating,
            communityRating,
            genresJson: JSON.stringify(genres),
            studiosJson: JSON.stringify(studios),
            tagsJson: JSON.stringify(tags),
            externalIdsJson: JSON.stringify(ids),
            fieldSourcesJson: JSON.stringify(sources),
          };
          yield* database.insert(catalogItemMetadata).values(metadata).onConflictDoUpdate({
            target: catalogItemMetadata.itemId,
            set: metadata,
          });
          const logos = object(payload.images).logos;
          const logoPath = Array.isArray(logos) ? object(logos[0]).file_path : null;
          for (const [role, imagePath] of [
            ["poster", payload.poster_path],
            ["backdrop", payload.backdrop_path],
            ["logo", logoPath],
            ["still", payload.still_path],
          ] as const) {
            if (item.kind === "episode" && role !== "still") continue;
            if (item.kind !== "episode" && role === "still") continue;
            if (typeof imagePath !== "string" || !/^\/[a-zA-Z0-9._-]+$/u.test(imagePath)) continue;
            const assigned = yield* database
              .select({ source: catalogItemArtwork.source })
              .from(catalogItemArtwork)
              .where(and(eq(catalogItemArtwork.itemId, itemId), eq(catalogItemArtwork.role, role)))
              .get();
            if (assigned != null && assigned.source !== "tmdb") continue;
            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(`https://image.tmdb.org/t/p/w780${imagePath}`, {
                  signal: AbortSignal.timeout(10_000),
                }),
              catch: (cause) => cause,
            });
            if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 20_000_000)
              continue;
            const bytes = yield* Effect.tryPromise({
              try: () => readResponseBytes(response, 20_000_000),
              catch: (cause) => cause,
            });
            const image = imageInfo(bytes);
            if (image === null || image.width < 1 || image.height < 1) continue;
            const mime = image.mimeType;
            const hash = createHash("sha256").update(bytes).digest("hex");
            const path = join(
              generatedArtworkDir(config.dataDir),
              `${hash}.${mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp"}`,
            );
            yield* Effect.promise(() =>
              mkdir(generatedArtworkDir(config.dataDir), { recursive: true }),
            );
            yield* Effect.tryPromise({
              try: async () => {
                try {
                  await writeFile(path, bytes, { flag: "wx" });
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
                  // Reusing a stored file: mark it fresh so an artwork sweep
                  // cannot remove it before this artwork row is written.
                  const now = new Date();
                  await utimes(path, now, now);
                }
              },
              catch: (cause) => cause,
            });
            const artworkId = newUuid();
            yield* database
              .insert(artworkTable)
              .values({
                id: artworkId,
                libraryId: item.libraryId,
                sourceId: null,
                kind: "other",
                mimeType: mime,
                width: image.width,
                height: image.height,
                byteSize: bytes.length,
                contentHash: hash,
                relativePath: path,
                createdAtMs: Date.now(),
              })
              .onConflictDoNothing();
            const stored = yield* database
              .select({ id: artworkTable.id })
              .from(artworkTable)
              .where(
                and(
                  eq(artworkTable.libraryId, item.libraryId),
                  or(
                    eq(artworkTable.relativePath, path),
                    and(eq(artworkTable.contentHash, hash), eq(artworkTable.kind, "other")),
                  ),
                ),
              )
              .limit(1)
              .get();
            if (stored != null)
              yield* database
                .insert(catalogItemArtwork)
                .values({
                  itemId,
                  role,
                  artworkId: stored.id,
                  source: "tmdb",
                })
                .onConflictDoUpdate({
                  target: [catalogItemArtwork.itemId, catalogItemArtwork.role],
                  set: { artworkId: stored.id },
                });
          }
        }
      },
    );
    return { enrichSource, episodeOrder, setEpisodeOrder };
  });

export class TmdbProvider extends Context.Service<TmdbProvider, MetadataProvider>()(
  "@lumen/server/Tmdb",
) {}
export const TmdbProviderLive = (config: ServerConfig) =>
  Layer.effect(TmdbProvider, makeTmdbProvider(config));
