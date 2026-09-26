import {
  albums,
  artists,
  artwork as artworkTable,
  catalogItemArtwork,
  catalogItemMetadata,
  catalogItemOrigins,
  catalogItems,
  catalogItemSources,
  Database,
  libraryProfiles,
  mediaSources,
  Repositories,
  streams as streamTable,
  tracks,
} from "@lumen/database";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { newUuid } from "../core/Security";
import { mapRepositoryError } from "../core/Cause";
import { Ffprobe } from "../media/Ffprobe";
import { parseVideoPath } from "./VideoPaths";
import { readLocalNfo } from "./LocalMetadata";
import { decodeMetadataList, decodeMetadataMap } from "./MetadataJson";
import { readLocalFile } from "./BoundedInput";
import { imageInfo } from "./ImageInfo";

const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .trim();

export interface MediaIngestShape {
  readonly ingest: (sourceId: string) => Effect.Effect<void, unknown>;
}

export const makeMediaIngest = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const ffprobe = yield* Ffprobe;

  const localMetadata = (itemId: string, nfoPath: string) =>
    Effect.gen(function* () {
      const nfo = yield* Effect.promise(() => readLocalNfo(nfoPath));
      if (nfo === null) return;
      const item = yield* database
        .select({
          title: catalogItems.title,
          overview: catalogItems.overview,
          year: catalogItems.year,
          metadataState: catalogItems.metadataState,
        })
        .from(catalogItems)
        .where(eq(catalogItems.id, itemId))
        .get();
      if (item == null) return;
      const old = yield* database
        .select()
        .from(catalogItemMetadata)
        .where(eq(catalogItemMetadata.itemId, itemId))
        .get();
      const locks = new Set(decodeMetadataList(old?.lockedFieldsJson ?? null));
      const sources = decodeMetadataMap(old?.fieldSourcesJson ?? null);
      const take = <T>(field: string, local: T | undefined, existing: T): T => {
        if (local === undefined || locks.has(field)) return existing;
        sources[field] = "nfo";
        return local;
      };
      const title = take("title", nfo.title, item.title);
      const overview = take("overview", nfo.overview, item.overview);
      const year = take("year", nfo.year, item.year);
      yield* database
        .update(catalogItems)
        .set({
          title,
          sortTitle: title.toLowerCase(),
          overview,
          year,
          metadataState: sql`case when ${catalogItems.metadataState} = 'user' then 'user' else 'nfo' end`,
          updatedAtMs: Date.now(),
        })
        .where(eq(catalogItems.id, itemId));
      const releaseDate = take("releaseDate", nfo.releaseDate, old?.releaseDate ?? null);
      const contentRating = take("contentRating", nfo.contentRating, old?.contentRating ?? null);
      const communityRating = take(
        "communityRating",
        nfo.communityRating,
        old?.communityRating ?? null,
      );
      const genresJson = JSON.stringify(
        take(
          "genres",
          nfo.genres?.length ? nfo.genres : undefined,
          decodeMetadataList(old?.genresJson ?? null),
        ),
      );
      const studiosJson = JSON.stringify(
        take(
          "studios",
          nfo.studios?.length ? nfo.studios : undefined,
          decodeMetadataList(old?.studiosJson ?? null),
        ),
      );
      const tagsJson = JSON.stringify(
        take(
          "tags",
          nfo.tags?.length ? nfo.tags : undefined,
          decodeMetadataList(old?.tagsJson ?? null),
        ),
      );
      const externalIds = decodeMetadataMap(old?.externalIdsJson ?? null);
      for (const [provider, id] of Object.entries(nfo.externalIds ?? {})) {
        if (!locks.has(provider)) externalIds[provider] = id;
      }
      const externalIdsJson = JSON.stringify(externalIds);
      const metadata = {
        itemId,
        releaseDate,
        contentRating,
        communityRating,
        genresJson,
        studiosJson,
        tagsJson,
        externalIdsJson,
        fieldSourcesJson: JSON.stringify(sources),
      };
      yield* database.insert(catalogItemMetadata).values(metadata).onConflictDoUpdate({
        target: catalogItemMetadata.itemId,
        set: metadata,
      });
    });

  const localArtwork = (
    itemId: string,
    libraryId: string,
    sourceId: string,
    role: "poster" | "backdrop" | "logo" | "still",
    paths: readonly string[],
  ) =>
    Effect.gen(function* () {
      const existing = yield* database
        .select({ source: catalogItemArtwork.source })
        .from(catalogItemArtwork)
        .where(and(eq(catalogItemArtwork.itemId, itemId), eq(catalogItemArtwork.role, role)))
        .get();
      if (existing?.source === "user") return;
      for (const path of paths) {
        const bytes = yield* Effect.promise(() => readLocalFile(path, 20 * 1024 * 1024));
        if (bytes === null) continue;
        const image = imageInfo(bytes);
        if (image === null || image.width < 1 || image.height < 1) continue;
        const artworkId = newUuid();
        const hash = hashBytes(bytes);
        const byPath = yield* database
          .select({ id: artworkTable.id })
          .from(artworkTable)
          .where(and(eq(artworkTable.libraryId, libraryId), eq(artworkTable.relativePath, path)))
          .get();
        if (byPath != null)
          yield* database
            .update(artworkTable)
            .set({
              mimeType: image.mimeType,
              width: image.width,
              height: image.height,
              byteSize: bytes.length,
              contentHash: hash,
            })
            .where(eq(artworkTable.id, byPath.id));
        yield* database
          .insert(artworkTable)
          .values({
            id: artworkId,
            libraryId,
            sourceId,
            kind: "other",
            mimeType: image.mimeType,
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
          .where(and(eq(artworkTable.libraryId, libraryId), eq(artworkTable.relativePath, path)))
          .get();
        if (stored == null) continue;
        yield* database
          .insert(catalogItemArtwork)
          .values({
            itemId,
            role,
            artworkId: stored.id,
            source: "local",
          })
          .onConflictDoUpdate({
            target: [catalogItemArtwork.itemId, catalogItemArtwork.role],
            set: { artworkId: stored.id, source: "local" },
          });
        break;
      }
    });

  const ingest: MediaIngestShape["ingest"] = Effect.fn("MediaIngest.ingest")(function* (sourceId) {
    const source = yield* database
      .select({
        id: mediaSources.id,
        libraryId: mediaSources.libraryId,
        rootId: mediaSources.rootId,
        relativePath: mediaSources.relativePath,
        absolutePath: mediaSources.absolutePath,
      })
      .from(mediaSources)
      .where(eq(mediaSources.id, sourceId))
      .get();
    if (source == null) return;
    const profile = yield* database
      .select({ kind: libraryProfiles.kind })
      .from(libraryProfiles)
      .where(eq(libraryProfiles.libraryId, source.libraryId))
      .get();
    const libraryKind = (profile?.kind ?? "movies") as "movies" | "shows" | "music";
    const parts = source.relativePath.split("/").filter(Boolean);
    const filename = parts.at(-1) ?? "Untitled";
    const video = libraryKind === "music" ? null : parseVideoPath(libraryKind, source.relativePath);
    if (video?.warning)
      console.warn("catalog_path_unmatched", {
        sourceId,
        relativePath: source.relativePath,
        reason: video.warning,
      });
    const itemTitle =
      video?.title ??
      (basename(filename, extname(filename)).replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim() ||
        "Untitled");
    const year = video?.year ?? null;
    const itemKind =
      libraryKind === "music" ? "track" : libraryKind === "shows" ? "episode" : "movie";
    const ensureFolder = (
      kind: "show" | "season",
      path: string,
      title: string,
      parentId: string | null,
      indexNumber: number | null,
      folderYear: number | null,
    ) =>
      Effect.gen(function* () {
        const existing = yield* database
          .select({ id: catalogItemOrigins.itemId })
          .from(catalogItemOrigins)
          .where(
            and(
              eq(catalogItemOrigins.rootId, source.rootId),
              eq(catalogItemOrigins.relativePath, path),
              eq(catalogItemOrigins.kind, kind),
            ),
          )
          .get();
        if (existing != null) return existing.id;
        const id = newUuid();
        const nowMs = Date.now();
        yield* database.insert(catalogItems).values({
          id,
          libraryId: source.libraryId,
          kind,
          parentId,
          title,
          sortTitle: title.toLowerCase(),
          year: folderYear,
          indexNumber,
          metadataState: "path",
          addedAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        yield* database.insert(catalogItemOrigins).values({
          itemId: id,
          rootId: source.rootId,
          relativePath: path,
          kind,
        });
        return id;
      });
    let parentId: string | null = null;
    if (video?.show !== null && video?.show !== undefined) {
      const show = video.show;
      const showId = yield* ensureFolder("show", show.path, show.title, null, null, show.year);
      parentId = showId;
      if (video.season !== null) {
        parentId = yield* ensureFolder(
          "season",
          video.season.path,
          video.season.number === 0 ? "Specials" : `Season ${video.season.number}`,
          showId,
          video.season.number,
          null,
        );
      }
    }
    const existingItem = yield* database
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .innerJoin(catalogItemSources, eq(catalogItemSources.itemId, catalogItems.id))
      .where(eq(catalogItemSources.sourceId, sourceId))
      .limit(1)
      .get();
    const itemId = existingItem?.id ?? newUuid();
    if (existingItem == null) {
      const nowMs = Date.now();
      yield* database.insert(catalogItems).values({
        id: itemId,
        libraryId: source.libraryId,
        kind: itemKind,
        title: itemTitle,
        sortTitle: itemTitle.toLowerCase(),
        year,
        metadataState: "path",
        addedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    if (video !== null) {
      const mayReplace = sql`${catalogItems.metadataState} in ('path', 'local')`;
      yield* database
        .update(catalogItems)
        .set({
          kind: itemKind,
          parentId,
          indexNumber: video.episodeNumber,
          title: sql`case when ${mayReplace} then ${itemTitle} else ${catalogItems.title} end`,
          sortTitle: sql`case when ${mayReplace} then ${itemTitle.toLowerCase()} else ${catalogItems.sortTitle} end`,
          year: sql`case when ${mayReplace} then ${year} else ${catalogItems.year} end`,
          updatedAtMs: Date.now(),
        })
        .where(eq(catalogItems.id, itemId));
      yield* database
        .insert(catalogItemOrigins)
        .values({
          itemId,
          rootId: source.rootId,
          relativePath: source.relativePath,
          kind: itemKind,
        })
        .onConflictDoUpdate({
          target: catalogItemOrigins.itemId,
          set: { rootId: source.rootId, relativePath: source.relativePath, kind: itemKind },
        });
    }
    yield* database
      .insert(catalogItemSources)
      .values({
        itemId,
        sourceId,
        isPrimary: existingItem == null,
        sourceGeneration: 1,
      })
      .onConflictDoNothing();
    const details = yield* Effect.tryPromise({
      try: () => lstat(source.absolutePath),
      catch: () => new Error("Media file is unavailable"),
    });
    if (!details.isFile() || details.isSymbolicLink()) return;
    if (video !== null) {
      const mediaDir = dirname(source.absolutePath);
      const showDir = video.show === null ? null : parts.length > 2 ? dirname(mediaDir) : mediaDir;
      const showOrigin =
        video.show === null
          ? null
          : yield* database
              .select({ id: catalogItemOrigins.itemId })
              .from(catalogItemOrigins)
              .where(
                and(
                  eq(catalogItemOrigins.rootId, source.rootId),
                  eq(catalogItemOrigins.relativePath, video.show.path),
                  eq(catalogItemOrigins.kind, "show"),
                ),
              )
              .get();
      const showId = showOrigin?.id ?? null;
      const seasonId = video.season === null ? null : parentId;
      if (showId !== null && showDir !== null) {
        yield* localMetadata(showId, join(showDir, "tvshow.nfo"));
        yield* localArtwork(
          showId,
          source.libraryId,
          sourceId,
          "poster",
          ["poster", "cover"].flatMap((name) =>
            [".jpg", ".png", ".webp"].map((ext) => join(showDir, name + ext)),
          ),
        );
        yield* localArtwork(
          showId,
          source.libraryId,
          sourceId,
          "backdrop",
          ["backdrop", "fanart"].flatMap((name) =>
            [".jpg", ".png", ".webp"].map((ext) => join(showDir, name + ext)),
          ),
        );
        yield* localArtwork(
          showId,
          source.libraryId,
          sourceId,
          "logo",
          ["logo", "clearlogo"].flatMap((name) =>
            [".png", ".webp"].map((ext) => join(showDir, name + ext)),
          ),
        );
      }
      if (seasonId !== null && seasonId !== showId) {
        yield* localMetadata(seasonId, join(mediaDir, "season.nfo"));
        yield* localArtwork(
          seasonId,
          source.libraryId,
          sourceId,
          "poster",
          ["poster.jpg", "poster.png", "season-poster.jpg"].map((name) => join(mediaDir, name)),
        );
      }
      if (video.kind === "movie") {
        const base = basename(source.absolutePath, extname(source.absolutePath));
        yield* localMetadata(
          itemId,
          join(mediaDir, parts.length > 1 ? "movie.nfo" : `${base}.nfo`),
        );
        yield* localArtwork(
          itemId,
          source.libraryId,
          sourceId,
          "poster",
          (parts.length > 1
            ? ["poster.jpg", "poster.png", `${base}.jpg`]
            : [`${base}.jpg`, `${base}.png`]
          ).map((name) => join(mediaDir, name)),
        );
        if (parts.length > 1)
          yield* localArtwork(
            itemId,
            source.libraryId,
            sourceId,
            "backdrop",
            ["backdrop.jpg", "fanart.jpg"].map((name) => join(mediaDir, name)),
          );
      } else {
        const base = basename(source.absolutePath, extname(source.absolutePath));
        yield* localMetadata(itemId, join(mediaDir, `${base}.nfo`));
        yield* localArtwork(
          itemId,
          source.libraryId,
          sourceId,
          "still",
          [`${base}-thumb.jpg`, `${base}-thumb.png`, `${base}.jpg`].map((name) =>
            join(mediaDir, name),
          ),
        );
      }
    }
    const probe = yield* ffprobe.probe(source.absolutePath);
    yield* database
      .update(catalogItems)
      .set({
        durationSeconds: probe.durationMs === null ? null : Math.round(probe.durationMs / 1000),
        updatedAtMs: Date.now(),
      })
      .where(eq(catalogItems.id, itemId));
    const existingTrack = yield* database
      .select({ id: tracks.id, primaryStreamId: tracks.primaryStreamId })
      .from(tracks)
      .where(eq(tracks.sourceId, sourceId))
      .get();
    const missingOrdinals =
      existingTrack == null
        ? null
        : yield* database
            .select({ count: count() })
            .from(streamTable)
            .where(and(eq(streamTable.sourceId, sourceId), isNull(streamTable.ordinal)))
            .get();
    const needsStreamRefresh = existingTrack == null ? false : (missingOrdinals?.count ?? 0) !== 0;
    const defaultOrdinals = new Set<number>();
    for (const kind of ["audio", "video", "subtitle"] as const) {
      const streams = probe.streams.filter((stream) => stream.kind === kind);
      const selected =
        streams.find((stream) => stream.isDefault) ??
        (kind === "audio" || kind === "video" ? streams[0] : undefined);
      if (selected !== undefined) defaultOrdinals.add(selected.ordinal);
    }
    let primaryStreamId: string | null = existingTrack?.primaryStreamId ?? null;
    if (existingTrack == null) {
      const parts = source.relativePath.split("/").filter(Boolean);
      const filename = parts.at(-1) ?? "Track";
      const title =
        basename(filename, extname(filename))
          .replaceAll("_", " ")
          .replaceAll(/\s+/gu, " ")
          .trim() || "Track";
      const albumTitle =
        libraryKind === "music" && parts.length > 2 ? (parts.at(-2) ?? null) : null;
      const artistName =
        libraryKind === "music" && parts.length > 2 ? (parts.at(-3) ?? null) : null;
      let albumId: string | null = null;
      if (artistName !== null) {
        const existingArtist = yield* database
          .select({ id: artists.id })
          .from(artists)
          .where(
            and(
              eq(artists.libraryId, source.libraryId),
              eq(artists.normalizedName, normalize(artistName)),
            ),
          )
          .get();
        const artist = yield* repositories.catalog
          .upsertArtist({
            id: existingArtist?.id ?? newUuid(),
            libraryId: source.libraryId,
            name: artistName,
            normalizedName: normalize(artistName),
            sortName: null,
            externalIds: {},
            nowMs: Date.now(),
          })
          .pipe(Effect.mapError(mapRepositoryError));
        if (albumTitle !== null) {
          const existingAlbum = yield* database
            .select({ id: albums.id })
            .from(albums)
            .where(
              and(
                eq(albums.libraryId, source.libraryId),
                eq(albums.normalizedTitle, normalize(albumTitle)),
                eq(albums.albumArtistId, artist.id),
              ),
            )
            .get();
          const album = yield* repositories.catalog
            .upsertAlbum({
              id: existingAlbum?.id ?? newUuid(),
              libraryId: source.libraryId,
              title: albumTitle,
              normalizedTitle: normalize(albumTitle),
              albumArtistId: artist.id,
              releaseDate: null,
              originalReleaseDate: null,
              releaseYear: null,
              barcode: null,
              externalIds: {},
              nowMs: Date.now(),
            })
            .pipe(Effect.mapError(mapRepositoryError));
          albumId = album.id;
        }
      }
      const ingested = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction.delete(streamTable).where(eq(streamTable.sourceId, sourceId));
          let primary: string | null = null;
          for (const stream of probe.streams) {
            const streamId = newUuid();
            yield* transaction.insert(streamTable).values({
              id: streamId,
              sourceId,
              kind: stream.kind,
              container: null,
              codec: stream.codec,
              language: stream.language,
              title: stream.title,
              ordinal: stream.ordinal,
              isDefault: defaultOrdinals.has(stream.ordinal),
              bitrate: stream.bitrate,
              sampleRateHz: stream.sampleRateHz,
              channels: stream.channels,
              width: stream.width,
              height: stream.height,
            });
            if (primary == null && (stream.kind === "audio" || stream.kind === "video"))
              primary = streamId;
          }
          if (primary !== null) {
            const nowMs = Date.now();
            yield* transaction.insert(tracks).values({
              id: newUuid(),
              libraryId: source.libraryId,
              sourceId,
              primaryStreamId: primary,
              albumId,
              title,
              normalizedTitle: normalize(title),
              trackNumber: null,
              discNumber: null,
              durationMs: probe.durationMs,
              isExplicit: false,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            });
          }
          return { primary };
        }),
      );
      primaryStreamId = ingested.primary;
    } else if (needsStreamRefresh && primaryStreamId !== null) {
      const currentPrimaryStreamId = primaryStreamId;
      const primary = probe.streams.find(
        (stream) => stream.kind === "audio" || stream.kind === "video",
      );
      if (primary !== undefined) {
        yield* database.transaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction
              .delete(streamTable)
              .where(
                and(eq(streamTable.sourceId, sourceId), ne(streamTable.id, currentPrimaryStreamId)),
              );
            yield* transaction
              .update(streamTable)
              .set({
                kind: primary.kind,
                container: null,
                codec: primary.codec,
                language: primary.language,
                title: primary.title,
                ordinal: primary.ordinal,
                isDefault: defaultOrdinals.has(primary.ordinal),
                bitrate: primary.bitrate,
                sampleRateHz: primary.sampleRateHz,
                channels: primary.channels,
                width: primary.width,
                height: primary.height,
              })
              .where(
                and(eq(streamTable.id, currentPrimaryStreamId), eq(streamTable.sourceId, sourceId)),
              );
            for (const stream of probe.streams) {
              if (stream.ordinal === primary.ordinal) continue;
              yield* transaction.insert(streamTable).values({
                id: newUuid(),
                sourceId,
                kind: stream.kind,
                container: null,
                codec: stream.codec,
                language: stream.language,
                title: stream.title,
                ordinal: stream.ordinal,
                isDefault: defaultOrdinals.has(stream.ordinal),
                bitrate: stream.bitrate,
                sampleRateHz: stream.sampleRateHz,
                channels: stream.channels,
                width: stream.width,
                height: stream.height,
              });
            }
            yield* transaction
              .update(tracks)
              .set({ durationMs: probe.durationMs, updatedAtMs: Date.now() })
              .where(eq(tracks.id, existingTrack.id));
          }),
        );
      }
    }
    const fingerprint = createHash("sha256")
      .update(`${source.absolutePath}:${details.size}:${Math.trunc(details.mtimeMs)}`)
      .digest("hex");
    yield* database
      .update(mediaSources)
      .set({ contentFingerprint: fingerprint })
      .where(eq(mediaSources.id, sourceId));
    const base = basename(source.absolutePath, extname(source.absolutePath));
    const sidecars = [
      [".lrc", "lyrics", "text/plain"],
      [".cue", "cue", "text/plain"],
      [".nfo", "nfo", "text/plain"],
      [".chapters", "chapters", "text/plain"],
    ] as const;
    if (primaryStreamId !== null) {
      for (const [suffix, kind, mediaType] of sidecars) {
        const sidecarPath = join(dirname(source.absolutePath), `${base}${suffix}`);
        const bytes = yield* Effect.promise(() => readLocalFile(sidecarPath, 256 * 1024));
        if (bytes === null) continue;
        yield* repositories.catalog
          .createSidecar({
            id: newUuid(),
            streamId: primaryStreamId,
            kind,
            relativePath: sidecarPath,
            mediaType,
            contentHash: hashBytes(bytes),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      for (const suffix of [".jpg", ".jpeg", ".png", ".webp"]) {
        const artworkPath = join(dirname(source.absolutePath), `${base}${suffix}`);
        const bytes = yield* Effect.promise(() => readLocalFile(artworkPath, 20 * 1024 * 1024));
        if (bytes === null) continue;
        const image = imageInfo(bytes);
        if (image === null || image.width < 1 || image.height < 1) continue;
        const artwork = yield* repositories.catalog
          .upsertArtwork({
            id: newUuid(),
            libraryId: source.libraryId,
            sourceId,
            kind: "front",
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            byteSize: bytes.byteLength,
            contentHash: hashBytes(bytes),
            relativePath: artworkPath,
            nowMs: Date.now(),
          })
          .pipe(Effect.mapError(mapRepositoryError));
        const track = yield* database
          .select({ id: tracks.id })
          .from(tracks)
          .where(eq(tracks.sourceId, sourceId))
          .get();
        if (track != null)
          yield* repositories.catalog
            .assignArtwork({
              artworkId: artwork.id,
              albumId: null,
              artistId: null,
              trackId: track.id,
              ordinal: 0,
              isPrimary: true,
            })
            .pipe(Effect.mapError(mapRepositoryError));
      }
    }
  });

  return { ingest };
});

export class MediaIngest extends Context.Service<MediaIngest, MediaIngestShape>()(
  "@lumen/server/MediaIngest",
) {}
export const MediaIngestLive = Layer.effect(MediaIngest, makeMediaIngest);
