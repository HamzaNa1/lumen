import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { newUuid } from "../core/Security";
import { mapRepositoryError } from "../core/Cause";
import { Ffprobe } from "../media/Ffprobe";
import { parseVideoPath } from "./VideoPaths";
import { readLocalNfo } from "./LocalMetadata";
import { readLocalFile } from "./BoundedInput";
import { imageInfo } from "./ImageInfo";

const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalize = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().trim();

export interface MediaIngestShape {
  readonly ingest: (sourceId: string) => Effect.Effect<void, unknown>;
}

export const makeMediaIngest = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const ffprobe = yield* Ffprobe;

  const localMetadata = (itemId: string, nfoPath: string) => Effect.gen(function* () {
    const nfo = yield* Effect.promise(() => readLocalNfo(nfoPath));
    if (nfo === null) return;
    const item = yield* database.get<{ title: string; overview: string | null; year: number | null; metadataState: string }>(sql`
      SELECT title, overview, year, metadata_state AS metadataState FROM catalog_items WHERE id = ${itemId}
    `);
    if (item == null) return;
    const old = yield* database.get<{
      releaseDate: string | null; contentRating: string | null; communityRating: number | null;
      genresJson: string; studiosJson: string; tagsJson: string; externalIdsJson: string; fieldSourcesJson: string; lockedFieldsJson: string;
    }>(sql`SELECT release_date AS releaseDate, content_rating AS contentRating, community_rating AS communityRating,
      genres_json AS genresJson, studios_json AS studiosJson, tags_json AS tagsJson, external_ids_json AS externalIdsJson,
      field_sources_json AS fieldSourcesJson, locked_fields_json AS lockedFieldsJson FROM catalog_item_metadata WHERE item_id = ${itemId}`);
    const locks = new Set<string>(JSON.parse(old?.lockedFieldsJson ?? "[]") as string[]);
    const sources = JSON.parse(old?.fieldSourcesJson ?? "{}") as Record<string, string>;
    const take = <T>(field: string, local: T | undefined, existing: T): T => {
      if (local === undefined || locks.has(field)) return existing;
      sources[field] = "nfo";
      return local;
    };
    const title = take("title", nfo.title, item.title);
    const overview = take("overview", nfo.overview, item.overview);
    const year = take("year", nfo.year, item.year);
    yield* database.run(sql`
      UPDATE catalog_items SET title = ${title}, sort_title = ${title.toLowerCase()}, overview = ${overview}, year = ${year},
        metadata_state = CASE WHEN metadata_state = 'user' THEN 'user' ELSE 'nfo' END,
        updated_at_ms = unixepoch() * 1000 WHERE id = ${itemId}
    `);
    const releaseDate = take("releaseDate", nfo.releaseDate, old?.releaseDate ?? null);
    const contentRating = take("contentRating", nfo.contentRating, old?.contentRating ?? null);
    const communityRating = take("communityRating", nfo.communityRating, old?.communityRating ?? null);
    const genresJson = JSON.stringify(take("genres", nfo.genres?.length ? nfo.genres : undefined, JSON.parse(old?.genresJson ?? "[]") as string[]));
    const studiosJson = JSON.stringify(take("studios", nfo.studios?.length ? nfo.studios : undefined, JSON.parse(old?.studiosJson ?? "[]") as string[]));
    const tagsJson = JSON.stringify(take("tags", nfo.tags?.length ? nfo.tags : undefined, JSON.parse(old?.tagsJson ?? "[]") as string[]));
    const externalIds = JSON.parse(old?.externalIdsJson ?? "{}") as Record<string, string>;
    for (const [provider, id] of Object.entries(nfo.externalIds ?? {})) {
      if (!locks.has(provider)) externalIds[provider] = id;
    }
    const externalIdsJson = JSON.stringify(externalIds);
    yield* database.run(sql`
      INSERT INTO catalog_item_metadata(item_id, release_date, content_rating, community_rating, genres_json, studios_json, tags_json, external_ids_json, field_sources_json)
      VALUES (${itemId}, ${releaseDate}, ${contentRating}, ${communityRating}, ${genresJson}, ${studiosJson}, ${tagsJson}, ${externalIdsJson}, ${JSON.stringify(sources)})
      ON CONFLICT(item_id) DO UPDATE SET release_date = excluded.release_date, content_rating = excluded.content_rating,
        community_rating = excluded.community_rating, genres_json = excluded.genres_json, studios_json = excluded.studios_json,
        tags_json = excluded.tags_json, external_ids_json = excluded.external_ids_json, field_sources_json = excluded.field_sources_json
    `);
  });

  const localArtwork = (itemId: string, libraryId: string, sourceId: string, role: "poster" | "backdrop" | "logo" | "still", paths: readonly string[]) => Effect.gen(function* () {
    const existing = yield* database.get<{ source: string }>(sql`SELECT source FROM catalog_item_artwork WHERE item_id = ${itemId} AND role = ${role}`);
    if (existing?.source === "user") return;
    for (const path of paths) {
      const bytes = yield* Effect.promise(() => readLocalFile(path, 20 * 1024 * 1024));
      if (bytes === null) continue;
      const image = imageInfo(bytes);
      if (image === null || image.width < 1 || image.height < 1) continue;
      const artworkId = newUuid();
      const hash = hashBytes(bytes);
      const byPath = yield* database.get<{ id: string }>(sql`
        SELECT id FROM artwork WHERE library_id = ${libraryId} AND relative_path = ${path}
      `);
      if (byPath != null) yield* database.run(sql`
        UPDATE artwork SET mime_type = ${image.mimeType}, width = ${image.width}, height = ${image.height},
          byte_size = ${bytes.length}, content_hash = ${hash} WHERE id = ${byPath.id}
      `);
      yield* database.run(sql`
        INSERT INTO artwork(id, library_id, source_id, kind, mime_type, width, height, byte_size, content_hash, relative_path, created_at_ms)
        VALUES (${artworkId}, ${libraryId}, ${sourceId}, 'other', ${image.mimeType}, ${image.width}, ${image.height}, ${bytes.length}, ${hash}, ${path}, unixepoch() * 1000)
        ON CONFLICT DO NOTHING
      `);
      const stored = yield* database.get<{ id: string }>(sql`
        SELECT id FROM artwork WHERE library_id = ${libraryId} AND relative_path = ${path}
      `);
      if (stored == null) continue;
      yield* database.run(sql`
        INSERT INTO catalog_item_artwork(item_id, role, artwork_id, source) VALUES (${itemId}, ${role}, ${stored.id}, 'local')
        ON CONFLICT(item_id, role) DO UPDATE SET artwork_id = excluded.artwork_id, source = 'local'
      `);
      break;
    }
  });

  const ingest: MediaIngestShape["ingest"] = Effect.fn("MediaIngest.ingest")(function* (sourceId) {
    const source = yield* database.get<{
      id: string;
      libraryId: string;
      rootId: string;
      relativePath: string;
      absolutePath: string;
    }>(sql`
      SELECT id, library_id AS libraryId, root_id AS rootId, relative_path AS relativePath, absolute_path AS absolutePath
      FROM media_sources WHERE id = ${sourceId}
    `);
    if (source == null) return;
    const libraryKind = (yield* database.get<{ kind: "movies" | "shows" | "music" }>(sql`
      SELECT kind FROM library_profiles WHERE library_id = ${source.libraryId}
    `))?.kind ?? "movies";
    const parts = source.relativePath.split("/").filter(Boolean);
    const filename = parts.at(-1) ?? "Untitled";
    const video = libraryKind === "music" ? null : parseVideoPath(libraryKind, source.relativePath);
    if (video?.warning) console.warn("catalog_path_unmatched", { sourceId, relativePath: source.relativePath, reason: video.warning });
    const itemTitle = video?.title ?? (basename(filename, extname(filename)).replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim() || "Untitled");
    const year = video?.year ?? null;
    const itemKind = libraryKind === "music" ? "track" : libraryKind === "shows" ? "episode" : "movie";
    const ensureFolder = (kind: "show" | "season", path: string, title: string, parentId: string | null, indexNumber: number | null, folderYear: number | null) => Effect.gen(function* () {
      const existing = yield* database.get<{ id: string }>(sql`
        SELECT item_id AS id FROM catalog_item_origins WHERE root_id = ${source.rootId} AND relative_path = ${path} AND kind = ${kind}
      `);
      if (existing != null) return existing.id;
      const id = newUuid();
      yield* database.run(sql`
        INSERT INTO catalog_items(id, library_id, kind, parent_id, title, sort_title, year, index_number, metadata_state, added_at_ms, updated_at_ms)
        VALUES (${id}, ${source.libraryId}, ${kind}, ${parentId}, ${title}, ${title.toLowerCase()}, ${folderYear}, ${indexNumber}, 'path', unixepoch() * 1000, unixepoch() * 1000)
      `);
      yield* database.run(sql`INSERT INTO catalog_item_origins(item_id, root_id, relative_path, kind) VALUES (${id}, ${source.rootId}, ${path}, ${kind})`);
      return id;
    });
    let parentId: string | null = null;
    if (video?.show !== null && video?.show !== undefined) {
      const show = video.show;
      const showId = yield* ensureFolder("show", show.path, show.title, null, null, show.year);
      parentId = showId;
      if (video.season !== null) {
        parentId = yield* ensureFolder("season", video.season.path, video.season.number === 0 ? "Specials" : `Season ${video.season.number}`, showId, video.season.number, null);
      }
    }
    const existingItem = yield* database.get<{ id: string }>(sql`
      SELECT i.id FROM catalog_items i
      JOIN catalog_item_sources s ON s.item_id = i.id
      WHERE s.source_id = ${sourceId}
      LIMIT 1
    `);
    const itemId = existingItem?.id ?? newUuid();
    if (existingItem === undefined) {
      yield* database.run(sql`
        INSERT INTO catalog_items(id, library_id, kind, title, sort_title, year, metadata_state, added_at_ms, updated_at_ms)
        VALUES (${itemId}, ${source.libraryId}, ${itemKind}, ${itemTitle}, ${itemTitle.toLowerCase()}, ${year}, 'path', unixepoch() * 1000, unixepoch() * 1000)
      `);
    }
    if (video !== null) {
      yield* database.run(sql`
        UPDATE catalog_items SET kind = ${itemKind}, parent_id = ${parentId}, index_number = ${video.episodeNumber},
          title = CASE WHEN metadata_state IN ('path', 'local') THEN ${itemTitle} ELSE title END,
          sort_title = CASE WHEN metadata_state IN ('path', 'local') THEN ${itemTitle.toLowerCase()} ELSE sort_title END,
          year = CASE WHEN metadata_state IN ('path', 'local') THEN ${year} ELSE year END,
          updated_at_ms = unixepoch() * 1000 WHERE id = ${itemId}
      `);
      yield* database.run(sql`
        INSERT INTO catalog_item_origins(item_id, root_id, relative_path, kind)
        VALUES (${itemId}, ${source.rootId}, ${source.relativePath}, ${itemKind})
        ON CONFLICT(item_id) DO UPDATE SET root_id = excluded.root_id, relative_path = excluded.relative_path, kind = excluded.kind
      `);
    }
    yield* database.run(sql`
      INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation)
      VALUES (${itemId}, ${sourceId}, 1, 1)
      ON CONFLICT(item_id, source_id) DO UPDATE SET is_primary = 1
    `);
    const details = yield* Effect.tryPromise({ try: () => lstat(source.absolutePath), catch: () => new Error("Media file is unavailable") });
    if (!details.isFile() || details.isSymbolicLink()) return;
    if (video !== null) {
      const mediaDir = dirname(source.absolutePath);
      const showDir = video.show === null ? null : parts.length > 2 ? dirname(mediaDir) : mediaDir;
      const showId = video.show === null ? null : (yield* database.get<{ id: string }>(sql`
        SELECT item_id AS id FROM catalog_item_origins WHERE root_id = ${source.rootId} AND relative_path = ${video.show.path} AND kind = 'show'
      `))?.id ?? null;
      const seasonId = video.season === null ? null : parentId;
      if (showId !== null && showDir !== null) {
        yield* localMetadata(showId, join(showDir, "tvshow.nfo"));
        yield* localArtwork(showId, source.libraryId, sourceId, "poster", ["poster", "cover"].flatMap((name) => [".jpg", ".png", ".webp"].map((ext) => join(showDir, name + ext))));
        yield* localArtwork(showId, source.libraryId, sourceId, "backdrop", ["backdrop", "fanart"].flatMap((name) => [".jpg", ".png", ".webp"].map((ext) => join(showDir, name + ext))));
        yield* localArtwork(showId, source.libraryId, sourceId, "logo", ["logo", "clearlogo"].flatMap((name) => [".png", ".webp"].map((ext) => join(showDir, name + ext))));
      }
      if (seasonId !== null && seasonId !== showId) {
        yield* localMetadata(seasonId, join(mediaDir, "season.nfo"));
        yield* localArtwork(seasonId, source.libraryId, sourceId, "poster", ["poster.jpg", "poster.png", "season-poster.jpg"].map((name) => join(mediaDir, name)));
      }
      if (video.kind === "movie") {
        const base = basename(source.absolutePath, extname(source.absolutePath));
        yield* localMetadata(itemId, join(mediaDir, parts.length > 1 ? "movie.nfo" : `${base}.nfo`));
        yield* localArtwork(itemId, source.libraryId, sourceId, "poster", (parts.length > 1 ? ["poster.jpg", "poster.png", `${base}.jpg`] : [`${base}.jpg`, `${base}.png`]).map((name) => join(mediaDir, name)));
        if (parts.length > 1) yield* localArtwork(itemId, source.libraryId, sourceId, "backdrop", ["backdrop.jpg", "fanart.jpg"].map((name) => join(mediaDir, name)));
      } else {
        const base = basename(source.absolutePath, extname(source.absolutePath));
        yield* localMetadata(itemId, join(mediaDir, `${base}.nfo`));
        yield* localArtwork(itemId, source.libraryId, sourceId, "still", [`${base}-thumb.jpg`, `${base}-thumb.png`, `${base}.jpg`].map((name) => join(mediaDir, name)));
      }
    }
    const probe = yield* ffprobe.probe(source.absolutePath);
    yield* database.run(sql`
      UPDATE catalog_items SET duration_seconds = ${probe.durationMs === null ? null : Math.round(probe.durationMs / 1000)}, updated_at_ms = unixepoch() * 1000
      WHERE id = ${itemId}
    `);
    const existingTrack = yield* database.get<{ id: string; primaryStreamId: string }>(sql`SELECT id, primary_stream_id AS primaryStreamId FROM tracks WHERE source_id = ${sourceId}`);
    const needsStreamRefresh = existingTrack === null ? false : (yield* database.get<{ count: number }>(sql`
      SELECT count(*) AS count FROM streams WHERE source_id = ${sourceId} AND ordinal IS NULL
    `))?.count !== 0;
    const defaultOrdinals = new Set<number>();
    for (const kind of ["audio", "video", "subtitle"] as const) {
      const streams = probe.streams.filter((stream) => stream.kind === kind);
      const selected = streams.find((stream) => stream.isDefault) ?? (kind === "audio" || kind === "video" ? streams[0] : undefined);
      if (selected !== undefined) defaultOrdinals.add(selected.ordinal);
    }
    let primaryStreamId: string | null = existingTrack?.primaryStreamId ?? null;
    if (existingTrack == null) {
      const parts = source.relativePath.split("/").filter(Boolean);
      const filename = parts.at(-1) ?? "Track";
      const title = basename(filename, extname(filename)).replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim() || "Track";
      const albumTitle = libraryKind === "music" && parts.length > 2 ? parts.at(-2) ?? null : null;
      const artistName = libraryKind === "music" && parts.length > 2 ? parts.at(-3) ?? null : null;
      let albumId: string | null = null;
      if (artistName !== null) {
        const artist = yield* repositories.catalog.upsertArtist({
          id: newUuid(), libraryId: source.libraryId, name: artistName, normalizedName: normalize(artistName), sortName: null, externalIds: {}, nowMs: Date.now(),
        }).pipe(Effect.mapError(mapRepositoryError));
        if (albumTitle !== null) {
          const album = yield* repositories.catalog.upsertAlbum({
            id: newUuid(), libraryId: source.libraryId, title: albumTitle, normalizedTitle: normalize(albumTitle), albumArtistId: artist.id,
            releaseDate: null, originalReleaseDate: null, releaseYear: null, barcode: null, externalIds: {}, nowMs: Date.now(),
          }).pipe(Effect.mapError(mapRepositoryError));
          albumId = album.id;
        }
      }
      const ingested = yield* database.transaction((transaction) => Effect.gen(function* () {
        yield* transaction.run(sql`DELETE FROM streams WHERE source_id = ${sourceId}`);
        let primary: string | null = null;
        for (const stream of probe.streams) {
          const streamId = newUuid();
          yield* transaction.run(sql`
            INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default, bitrate, sample_rate_hz, channels, width, height)
            VALUES (${streamId}, ${sourceId}, ${stream.kind}, NULL, ${stream.codec}, ${stream.language}, ${stream.title}, ${stream.ordinal}, ${defaultOrdinals.has(stream.ordinal) ? 1 : 0}, ${stream.bitrate}, ${stream.sampleRateHz}, ${stream.channels}, ${stream.width}, ${stream.height})
          `);
          if (primary == null && (stream.kind === "audio" || stream.kind === "video")) primary = streamId;
        }
        if (primary !== null) {
          yield* transaction.run(sql`
            INSERT INTO tracks(id, library_id, source_id, primary_stream_id, album_id, title, normalized_title, track_number, disc_number, duration_ms, is_explicit, created_at_ms, updated_at_ms)
            VALUES (${newUuid()}, ${source.libraryId}, ${sourceId}, ${primary}, ${albumId}, ${title}, ${normalize(title)}, NULL, NULL, ${probe.durationMs}, 0, unixepoch() * 1000, unixepoch() * 1000)
          `);
        }
        return { primary };
      }));
      primaryStreamId = ingested.primary;
    } else if (needsStreamRefresh && primaryStreamId !== null) {
      const primary = probe.streams.find((stream) => stream.kind === "audio" || stream.kind === "video");
      if (primary !== undefined) {
        yield* database.transaction((transaction) => Effect.gen(function* () {
          yield* transaction.run(sql`DELETE FROM streams WHERE source_id = ${sourceId} AND id <> ${primaryStreamId}`);
          yield* transaction.run(sql`
            UPDATE streams SET kind = ${primary.kind}, container = NULL, codec = ${primary.codec}, language = ${primary.language}, title = ${primary.title}, ordinal = ${primary.ordinal}, is_default = ${defaultOrdinals.has(primary.ordinal) ? 1 : 0}, bitrate = ${primary.bitrate}, sample_rate_hz = ${primary.sampleRateHz}, channels = ${primary.channels}, width = ${primary.width}, height = ${primary.height}
            WHERE id = ${primaryStreamId} AND source_id = ${sourceId}
          `);
          for (const stream of probe.streams) {
            if (stream.ordinal === primary.ordinal) continue;
            yield* transaction.run(sql`
              INSERT INTO streams(id, source_id, kind, container, codec, language, title, ordinal, is_default, bitrate, sample_rate_hz, channels, width, height)
              VALUES (${newUuid()}, ${sourceId}, ${stream.kind}, NULL, ${stream.codec}, ${stream.language}, ${stream.title}, ${stream.ordinal}, ${defaultOrdinals.has(stream.ordinal) ? 1 : 0}, ${stream.bitrate}, ${stream.sampleRateHz}, ${stream.channels}, ${stream.width}, ${stream.height})
            `);
          }
          yield* transaction.run(sql`UPDATE tracks SET duration_ms = ${probe.durationMs}, updated_at_ms = unixepoch() * 1000 WHERE id = ${existingTrack.id}`);
        }));
      }
    }
    const fingerprint = createHash("sha256").update(`${source.absolutePath}:${details.size}:${Math.trunc(details.mtimeMs)}`).digest("hex");
    yield* database.run(sql`UPDATE media_sources SET content_fingerprint = ${fingerprint} WHERE id = ${sourceId}`);
    const base = basename(source.absolutePath, extname(source.absolutePath));
    const sidecars = [
      [".lrc", "lyrics", "text/plain"], [".cue", "cue", "text/plain"], [".nfo", "nfo", "text/plain"], [".chapters", "chapters", "text/plain"],
    ] as const;
    if (primaryStreamId !== null) {
      for (const [suffix, kind, mediaType] of sidecars) {
        const sidecarPath = join(dirname(source.absolutePath), `${base}${suffix}`);
        const bytes = yield* Effect.promise(() => readLocalFile(sidecarPath, 256 * 1024));
        if (bytes === null) continue;
        yield* repositories.catalog.createSidecar({
          id: newUuid(), streamId: primaryStreamId, kind, relativePath: sidecarPath, mediaType, contentHash: hashBytes(bytes),
        }).pipe(Effect.catch(() => Effect.void));
      }
      for (const suffix of [".jpg", ".jpeg", ".png", ".webp"]) {
        const artworkPath = join(dirname(source.absolutePath), `${base}${suffix}`);
        const bytes = yield* Effect.promise(() => readLocalFile(artworkPath, 20 * 1024 * 1024));
        if (bytes === null) continue;
        const image = imageInfo(bytes);
        if (image === null || image.width < 1 || image.height < 1) continue;
        const artwork = yield* repositories.catalog.upsertArtwork({
          id: newUuid(), libraryId: source.libraryId, sourceId, kind: "front", mimeType: image.mimeType,
          width: image.width, height: image.height, byteSize: bytes.byteLength, contentHash: hashBytes(bytes), relativePath: artworkPath, nowMs: Date.now(),
        }).pipe(Effect.mapError(mapRepositoryError));
        const track = yield* database.get<{ id: string }>(sql`SELECT id FROM tracks WHERE source_id = ${sourceId}`);
        if (track !== null) yield* repositories.catalog.assignArtwork({ artworkId: artwork.id, albumId: null, artistId: null, trackId: track.id, ordinal: 0, isPrimary: true }).pipe(Effect.mapError(mapRepositoryError));
      }
    }
  });

  return { ingest };
});

export class MediaIngest extends Context.Service<MediaIngest, MediaIngestShape>()("@lumen/server/MediaIngest") {}
export const MediaIngestLive = Layer.effect(MediaIngest, makeMediaIngest);
