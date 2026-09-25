import {
  Album,
  Artist,
  Artwork,
  ArtworkAssignment,
  AssignArtwork,
  Chapter,
  CreateChapter,
  CreateMediaSource,
  CreateSidecar,
  CreateStream,
  CreateTrack,
  MediaSource,
  Stream,
  StreamSidecar,
  Track,
  TrackArtist,
  TrackMetadata,
  UpsertAlbum,
  UpsertArtist,
  UpsertArtwork,
  UpsertTrackMetadata,
  Uuid,
} from "@lumen/contracts";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import {
  albums,
  artists,
  artwork,
  artworkAssignments,
  chapters,
  mediaSources,
  streamSidecars,
  streams,
  trackArtists,
  trackMetadata,
  tracks,
} from "../tables/schema";
import { catalogItems } from "../tables/ServerSchema";
import { boundary, encodeJson, guard } from "./Boundary";

const sourceSelection = {
  id: mediaSources.id,
  libraryId: mediaSources.libraryId,
  rootId: mediaSources.rootId,
  relativePath: mediaSources.relativePath,
  absolutePath: mediaSources.absolutePath,
  kind: mediaSources.kind,
  fileSizeBytes: mediaSources.fileSizeBytes,
  modifiedAtMs: mediaSources.modifiedAtMs,
  inode: mediaSources.inode,
  contentFingerprint: mediaSources.contentFingerprint,
  scannedAtMs: mediaSources.scannedAtMs,
};

const streamSelection = {
  id: streams.id,
  sourceId: streams.sourceId,
  kind: streams.kind,
  container: streams.container,
  codec: streams.codec,
  language: streams.language,
  title: streams.title,
  ordinal: streams.ordinal,
  isDefault: streams.isDefault,
  bitrate: streams.bitrate,
  sampleRateHz: streams.sampleRateHz,
  channels: streams.channels,
  width: streams.width,
  height: streams.height,
};

const chapterSelection = {
  id: chapters.id,
  streamId: chapters.streamId,
  ordinal: chapters.ordinal,
  title: chapters.title,
  startMs: chapters.startMs,
  endMs: chapters.endMs,
};

const sidecarSelection = {
  id: streamSidecars.id,
  streamId: streamSidecars.streamId,
  kind: streamSidecars.kind,
  relativePath: streamSidecars.relativePath,
  mediaType: streamSidecars.mediaType,
  contentHash: streamSidecars.contentHash,
};

const artistSelection = {
  id: artists.id,
  libraryId: artists.libraryId,
  name: artists.name,
  normalizedName: artists.normalizedName,
  sortName: artists.sortName,
  externalIdsJson: artists.externalIdsJson,
  createdAtMs: artists.createdAtMs,
  updatedAtMs: artists.updatedAtMs,
};

const albumSelection = {
  id: albums.id,
  libraryId: albums.libraryId,
  title: albums.title,
  normalizedTitle: albums.normalizedTitle,
  albumArtistId: albums.albumArtistId,
  releaseDate: albums.releaseDate,
  originalReleaseDate: albums.originalReleaseDate,
  releaseYear: albums.releaseYear,
  barcode: albums.barcode,
  externalIdsJson: albums.externalIdsJson,
  createdAtMs: albums.createdAtMs,
  updatedAtMs: albums.updatedAtMs,
};

const trackSelection = {
  id: tracks.id,
  libraryId: tracks.libraryId,
  sourceId: tracks.sourceId,
  primaryStreamId: tracks.primaryStreamId,
  albumId: tracks.albumId,
  title: tracks.title,
  normalizedTitle: tracks.normalizedTitle,
  trackNumber: tracks.trackNumber,
  discNumber: tracks.discNumber,
  durationMs: tracks.durationMs,
  isExplicit: tracks.isExplicit,
  createdAtMs: tracks.createdAtMs,
  updatedAtMs: tracks.updatedAtMs,
};

const metadataSelection = {
  trackId: trackMetadata.trackId,
  namespace: trackMetadata.namespace,
  key: trackMetadata.key,
  valueJson: trackMetadata.valueJson,
  language: trackMetadata.language,
  sourceId: trackMetadata.sourceId,
  updatedAtMs: trackMetadata.updatedAtMs,
};

const artworkSelection = {
  id: artwork.id,
  libraryId: artwork.libraryId,
  sourceId: artwork.sourceId,
  kind: artwork.kind,
  mimeType: artwork.mimeType,
  width: artwork.width,
  height: artwork.height,
  byteSize: artwork.byteSize,
  contentHash: artwork.contentHash,
  relativePath: artwork.relativePath,
  createdAtMs: artwork.createdAtMs,
};

const StreamId = Schema.Struct({ streamId: Uuid });
const TrackId = Schema.Struct({ trackId: Uuid });

export const makeCatalogRepository = (database: DatabaseClient) => {
  const createSource = Effect.fn("CatalogRepository.createSource")(function* (input: unknown) {
    const value = yield* boundary(CreateMediaSource, input, "catalog.createSource");
    const resultRows = yield* guard(
      database
        .insert(mediaSources)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          rootId: value.rootId,
          relativePath: value.relativePath,
          absolutePath: value.absolutePath,
          kind: value.kind,
          fileSizeBytes: value.fileSizeBytes,
          modifiedAtMs: value.modifiedAtMs,
          inode: value.inode,
          contentFingerprint: value.contentFingerprint,
          scannedAtMs: value.scannedAtMs,
        })
        .returning(sourceSelection),
      "catalog.createSource",
    );
    const [row] = resultRows;
    return yield* boundary(MediaSource, row, "catalog.createSource.result");
  });

  const createStream = Effect.fn("CatalogRepository.createStream")(function* (input: unknown) {
    const value = yield* boundary(CreateStream, input, "catalog.createStream");
    const resultRows = yield* guard(
      database
        .insert(streams)
        .values({
          id: value.id,
          sourceId: value.sourceId,
          kind: value.kind,
          container: value.container,
          codec: value.codec,
          language: value.language,
          title: value.title,
          ordinal: value.ordinal,
          isDefault: value.isDefault,
          bitrate: value.bitrate,
          sampleRateHz: value.sampleRateHz,
          channels: value.channels,
          width: value.width,
          height: value.height,
        })
        .returning(streamSelection),
      "catalog.createStream",
    );
    const [row] = resultRows;
    return yield* boundary(Stream, row, "catalog.createStream.result");
  });

  const createChapter = Effect.fn("CatalogRepository.createChapter")(function* (input: unknown) {
    const value = yield* boundary(CreateChapter, input, "catalog.createChapter");
    const resultRows = yield* guard(
      database
        .insert(chapters)
        .values({
          id: value.id,
          streamId: value.streamId,
          ordinal: value.ordinal,
          title: value.title,
          startMs: value.startMs,
          endMs: value.endMs,
        })
        .returning(chapterSelection),
      "catalog.createChapter",
    );
    const [row] = resultRows;
    return yield* boundary(Chapter, row, "catalog.createChapter.result");
  });

  const createSidecar = Effect.fn("CatalogRepository.createSidecar")(function* (input: unknown) {
    const value = yield* boundary(CreateSidecar, input, "catalog.createSidecar");
    const resultRows = yield* guard(
      database
        .insert(streamSidecars)
        .values({
          id: value.id,
          streamId: value.streamId,
          kind: value.kind,
          relativePath: value.relativePath,
          mediaType: value.mediaType,
          contentHash: value.contentHash,
        })
        .returning(sidecarSelection),
      "catalog.createSidecar",
    );
    const [row] = resultRows;
    return yield* boundary(StreamSidecar, row, "catalog.createSidecar.result");
  });

  const upsertArtist = Effect.fn("CatalogRepository.upsertArtist")(function* (input: unknown) {
    const value = yield* boundary(UpsertArtist, input, "catalog.upsertArtist");
    const externalIdsJson = yield* encodeJson(value.externalIds, "catalog.upsertArtist.encode");
    const resultRows = yield* guard(
      database
        .insert(artists)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          name: value.name,
          normalizedName: value.normalizedName,
          sortName: value.sortName,
          externalIdsJson,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: artists.id,
          set: {
            name: value.name,
            normalizedName: value.normalizedName,
            sortName: value.sortName,
            externalIdsJson,
            updatedAtMs: value.nowMs,
          },
        })
        .returning(artistSelection),
      "catalog.upsertArtist",
    );
    const [row] = resultRows;
    return yield* boundary(Artist, row, "catalog.upsertArtist.result");
  });

  const upsertAlbum = Effect.fn("CatalogRepository.upsertAlbum")(function* (input: unknown) {
    const value = yield* boundary(UpsertAlbum, input, "catalog.upsertAlbum");
    const externalIdsJson = yield* encodeJson(value.externalIds, "catalog.upsertAlbum.encode");
    const resultRows = yield* guard(
      database
        .insert(albums)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          title: value.title,
          normalizedTitle: value.normalizedTitle,
          albumArtistId: value.albumArtistId,
          releaseDate: value.releaseDate,
          originalReleaseDate: value.originalReleaseDate,
          releaseYear: value.releaseYear,
          barcode: value.barcode,
          externalIdsJson,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: albums.id,
          set: {
            title: value.title,
            normalizedTitle: value.normalizedTitle,
            albumArtistId: value.albumArtistId,
            releaseDate: value.releaseDate,
            originalReleaseDate: value.originalReleaseDate,
            releaseYear: value.releaseYear,
            barcode: value.barcode,
            externalIdsJson,
            updatedAtMs: value.nowMs,
          },
        })
        .returning(albumSelection),
      "catalog.upsertAlbum",
    );
    const [row] = resultRows;
    return yield* boundary(Album, row, "catalog.upsertAlbum.result");
  });

  const createTrack = Effect.fn("CatalogRepository.createTrack")(function* (input: unknown) {
    const value = yield* boundary(CreateTrack, input, "catalog.createTrack");
    const resultRows = yield* guard(
      database
        .insert(tracks)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          sourceId: value.sourceId,
          primaryStreamId: value.primaryStreamId,
          albumId: value.albumId,
          title: value.title,
          normalizedTitle: value.normalizedTitle,
          trackNumber: value.trackNumber,
          discNumber: value.discNumber,
          durationMs: value.durationMs,
          isExplicit: value.isExplicit,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .returning(trackSelection),
      "catalog.createTrack",
    );
    const [row] = resultRows;
    return yield* boundary(Track, row, "catalog.createTrack.result");
  });

  const attachArtist = Effect.fn("CatalogRepository.attachArtist")(function* (input: unknown) {
    const value = yield* boundary(TrackArtist, input, "catalog.attachArtist");
    const resultRows = yield* guard(
      database
        .insert(trackArtists)
        .values(value)
        .onConflictDoUpdate({
          target: [trackArtists.trackId, trackArtists.artistId, trackArtists.role],
          set: { ordinal: value.ordinal },
        })
        .returning(),
      "catalog.attachArtist",
    );
    const [row] = resultRows;
    return yield* boundary(TrackArtist, row, "catalog.attachArtist.result");
  });

  const upsertMetadata = Effect.fn("CatalogRepository.upsertMetadata")(function* (input: unknown) {
    const value = yield* boundary(UpsertTrackMetadata, input, "catalog.upsertMetadata");
    const valueJson = yield* encodeJson(value.value, "catalog.upsertMetadata.encode");
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const conditions = [
            eq(trackMetadata.trackId, value.trackId),
            eq(trackMetadata.namespace, value.namespace),
            eq(trackMetadata.key, value.key),
          ];
          yield* transaction
            .delete(trackMetadata)
            .where(
              value.language === null
                ? and(...conditions, isNull(trackMetadata.language))
                : and(...conditions, eq(trackMetadata.language, value.language)),
            );
          const [created] = yield* transaction
            .insert(trackMetadata)
            .values({
              trackId: value.trackId,
              namespace: value.namespace,
              key: value.key,
              valueJson,
              language: value.language,
              sourceId: value.sourceId,
              updatedAtMs: value.nowMs,
            })
            .returning(metadataSelection);
          return created;
        }),
      ),
      "catalog.upsertMetadata",
    );
    return yield* boundary(TrackMetadata, row, "catalog.upsertMetadata.result");
  });

  const upsertArtwork = Effect.fn("CatalogRepository.upsertArtwork")(function* (input: unknown) {
    const value = yield* boundary(UpsertArtwork, input, "catalog.upsertArtwork");
    const resultRows = yield* guard(
      database
        .insert(artwork)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          sourceId: value.sourceId,
          kind: value.kind,
          mimeType: value.mimeType,
          width: value.width,
          height: value.height,
          byteSize: value.byteSize,
          contentHash: value.contentHash,
          relativePath: value.relativePath,
          createdAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: artwork.id,
          set: {
            sourceId: value.sourceId,
            kind: value.kind,
            mimeType: value.mimeType,
            width: value.width,
            height: value.height,
            byteSize: value.byteSize,
            contentHash: value.contentHash,
            relativePath: value.relativePath,
          },
        })
        .returning(artworkSelection),
      "catalog.upsertArtwork",
    );
    const [row] = resultRows;
    return yield* boundary(Artwork, row, "catalog.upsertArtwork.result");
  });

  const assignArtwork = Effect.fn("CatalogRepository.assignArtwork")(function* (input: unknown) {
    const value = yield* boundary(AssignArtwork, input, "catalog.assignArtwork");
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const targetCondition =
            value.albumId !== null
              ? eq(artworkAssignments.albumId, value.albumId)
              : value.artistId !== null
                ? eq(artworkAssignments.artistId, value.artistId)
                : eq(artworkAssignments.trackId, value.trackId ?? "");
          if (value.isPrimary) {
            yield* transaction
              .delete(artworkAssignments)
              .where(and(targetCondition, eq(artworkAssignments.isPrimary, true)));
          }
          yield* transaction
            .delete(artworkAssignments)
            .where(and(targetCondition, eq(artworkAssignments.ordinal, value.ordinal)));
          const [created] = yield* transaction
            .insert(artworkAssignments)
            .values({
              artworkId: value.artworkId,
              albumId: value.albumId,
              artistId: value.artistId,
              trackId: value.trackId,
              ordinal: value.ordinal,
              isPrimary: value.isPrimary,
            })
            .returning();
          return created;
        }),
      ),
      "catalog.assignArtwork",
    );
    return yield* boundary(ArtworkAssignment, row, "catalog.assignArtwork.result");
  });

  const getTrack = Effect.fn("CatalogRepository.getTrack")(function* (input: unknown) {
    const value = yield* boundary(TrackId, input, "catalog.getTrack");
    const row = yield* guard(
      database.select(trackSelection).from(tracks).where(eq(tracks.id, value.trackId)).get(),
      "catalog.getTrack",
    );
    return yield* boundary(Track, row, "catalog.getTrack.result");
  });

  const listChapters = Effect.fn("CatalogRepository.listChapters")(function* (input: unknown) {
    const value = yield* boundary(StreamId, input, "catalog.listChapters");
    const rows = yield* guard(
      database
        .select(chapterSelection)
        .from(chapters)
        .where(eq(chapters.streamId, value.streamId))
        .orderBy(asc(chapters.ordinal)),
      "catalog.listChapters",
    );
    return yield* boundary(Schema.Array(Chapter), rows, "catalog.listChapters.result");
  });

  const listMetadata = Effect.fn("CatalogRepository.listMetadata")(function* (input: unknown) {
    const value = yield* boundary(TrackId, input, "catalog.listMetadata");
    const rows = yield* guard(
      database
        .select(metadataSelection)
        .from(trackMetadata)
        .where(eq(trackMetadata.trackId, value.trackId)),
      "catalog.listMetadata",
    );
    return yield* boundary(Schema.Array(TrackMetadata), rows, "catalog.listMetadata.result");
  });

  const descendantItemIds = Effect.fn("CatalogRepository.descendantItemIds")(function* (
    itemId: string,
  ) {
    const descendants = new Set([itemId]);
    let frontier = [itemId];
    while (frontier.length > 0) {
      const children = yield* guard(
        database
          .select({ id: catalogItems.id })
          .from(catalogItems)
          .where(inArray(catalogItems.parentId, frontier)),
        "catalog.descendantItemIds",
      );
      frontier = children.map((child) => child.id).filter((id) => !descendants.has(id));
      for (const id of frontier) descendants.add(id);
    }
    return [...descendants];
  });

  return {
    createSource,
    createStream,
    createChapter,
    createSidecar,
    upsertArtist,
    upsertAlbum,
    createTrack,
    attachArtist,
    upsertMetadata,
    upsertArtwork,
    assignArtwork,
    getTrack,
    listChapters,
    listMetadata,
    descendantItemIds,
  };
};

export type CatalogRepository = ReturnType<typeof makeCatalogRepository>;
