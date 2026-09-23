import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { newUuid } from "../core/Security";
import { mapRepositoryError } from "../core/Cause";
import { Ffprobe } from "../media/Ffprobe";

const extensionMime = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
]);

const imageDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker >= 192 && marker <= 195 && offset + 9 < bytes.length) {
        return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
      }
      offset += 2 + length;
    }
  }
  return null;
};

const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalize = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().trim();

export interface MediaIngestShape {
  readonly ingest: (sourceId: string) => Effect.Effect<void, unknown>;
}

export const makeMediaIngest = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const ffprobe = yield* Ffprobe;

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
    const itemTitle = basename(filename, extname(filename)).replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim() || "Untitled";
    const yearMatch = /(?:19|20)\d{2}/u.exec(itemTitle);
    const year = yearMatch === null ? null : Number(yearMatch[0]);
    const itemKind = libraryKind === "music" ? "track" : libraryKind === "shows" ? "episode" : "movie";
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
        VALUES (${itemId}, ${source.libraryId}, ${itemKind}, ${itemTitle}, ${itemTitle.toLowerCase()}, ${year}, 'local', unixepoch() * 1000, unixepoch() * 1000)
      `);
    }
    yield* database.run(sql`
      INSERT INTO catalog_item_sources(item_id, source_id, is_primary, source_generation)
      VALUES (${itemId}, ${sourceId}, 1, 1)
      ON CONFLICT(item_id, source_id) DO UPDATE SET is_primary = 1
    `);
    const details = yield* Effect.tryPromise({ try: () => lstat(source.absolutePath), catch: () => new Error("Media file is unavailable") });
    if (!details.isFile() || details.isSymbolicLink()) return;
    const probe = yield* ffprobe.probe(source.absolutePath);
    yield* database.run(sql`
      UPDATE catalog_items SET duration_seconds = ${probe.durationMs === null ? null : Math.round(probe.durationMs / 1000)}, updated_at_ms = unixepoch() * 1000
      WHERE id = ${itemId}
    `);
    const existingTrack = yield* database.get<{ id: string }>(sql`SELECT id FROM tracks WHERE source_id = ${sourceId}`);
    let primaryStreamId: string | null = null;
    if (existingTrack == null) {
      for (const [index, stream] of probe.streams.entries()) {
        const streamId = newUuid();
        yield* database.run(sql`
          INSERT INTO streams(id, source_id, kind, container, codec, language, is_default, bitrate, sample_rate_hz, channels, width, height)
          VALUES (${streamId}, ${sourceId}, ${stream.kind}, NULL, ${stream.codec}, ${stream.language}, ${index === 0 ? 1 : 0}, ${stream.bitrate}, ${stream.sampleRateHz}, ${stream.channels}, ${stream.width}, ${stream.height})
        `);
        if (primaryStreamId == null && (stream.kind === "audio" || stream.kind === "video")) primaryStreamId = streamId;
      }
      if (primaryStreamId !== null) {
        const parts = source.relativePath.split("/").filter(Boolean);
        const filename = parts.at(-1) ?? "Track";
        const title = basename(filename, extname(filename)).replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim() || "Track";
        const albumTitle = parts.length > 2 ? parts.at(-2) ?? null : null;
        const artistName = parts.length > 2 ? parts.at(-3) ?? null : null;
        let albumId: string | null = null;
        let artistId: string | null = null;
        if (artistName !== null) {
          const artist = yield* repositories.catalog.upsertArtist({
            id: newUuid(), libraryId: source.libraryId, name: artistName, normalizedName: normalize(artistName), sortName: null, externalIds: {}, nowMs: Date.now(),
          }).pipe(Effect.mapError(mapRepositoryError));
          artistId = artist.id;
          if (albumTitle !== null) {
            const album = yield* repositories.catalog.upsertAlbum({
              id: newUuid(), libraryId: source.libraryId, title: albumTitle, normalizedTitle: normalize(albumTitle), albumArtistId: artist.id,
              releaseDate: null, originalReleaseDate: null, releaseYear: null, barcode: null, externalIds: {}, nowMs: Date.now(),
            }).pipe(Effect.mapError(mapRepositoryError));
            albumId = album.id;
          }
        }
        yield* database.run(sql`
          INSERT INTO tracks(id, library_id, source_id, primary_stream_id, album_id, title, normalized_title, track_number, disc_number, duration_ms, is_explicit, created_at_ms, updated_at_ms)
          VALUES (${newUuid()}, ${source.libraryId}, ${sourceId}, ${primaryStreamId}, ${albumId}, ${title}, ${normalize(title)}, NULL, NULL, ${probe.durationMs}, 0, unixepoch() * 1000, unixepoch() * 1000)
        `);
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
        const sidecarDetails = yield* Effect.tryPromise({ try: () => lstat(sidecarPath), catch: () => null });
        if (sidecarDetails == null || !sidecarDetails.isFile() || sidecarDetails.isSymbolicLink()) continue;
        const bytes = yield* Effect.tryPromise({ try: () => readFile(sidecarPath), catch: () => new Uint8Array() });
        yield* repositories.catalog.createSidecar({
          id: newUuid(), streamId: primaryStreamId, kind, relativePath: sidecarPath, mediaType, contentHash: hashBytes(bytes),
        }).pipe(Effect.catch(() => Effect.void));
      }
      for (const suffix of [".jpg", ".jpeg", ".png", ".webp"]) {
        const artworkPath = join(dirname(source.absolutePath), `${base}${suffix}`);
        const artworkDetails = yield* Effect.tryPromise({ try: () => lstat(artworkPath), catch: () => null });
        if (artworkDetails == null || !artworkDetails.isFile() || artworkDetails.isSymbolicLink()) continue;
        const bytes = yield* Effect.tryPromise({ try: () => readFile(artworkPath), catch: () => new Uint8Array() });
        const dimensions = imageDimensions(bytes);
        if (dimensions == null) continue;
        const artwork = yield* repositories.catalog.upsertArtwork({
          id: newUuid(), libraryId: source.libraryId, sourceId, kind: "front", mimeType: extensionMime.get(suffix) ?? "application/octet-stream",
          width: dimensions.width, height: dimensions.height, byteSize: bytes.byteLength, contentHash: hashBytes(bytes), relativePath: artworkPath, nowMs: Date.now(),
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
