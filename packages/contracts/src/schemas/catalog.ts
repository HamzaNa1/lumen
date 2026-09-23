import { Schema } from "effect";
import { DurationMillis, NonEmptyText, Sha256Digest, UtcMillis, Uuid } from "./common";

export const MediaSourceKind = Schema.Literals(["local", "smb", "nfs", "remote"]);
export const StreamKind = Schema.Literals(["audio", "video", "subtitle"]);
export const SidecarKind = Schema.Literals([
  "cue",
  "nfo",
  "lyrics",
  "chapters",
  "artwork",
  "other",
]);
export const MetadataNamespace = Schema.Literals([
  "core",
  "technical",
  "tag",
  "external",
  "analysis",
]);

export const MediaSource = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  rootId: Uuid,
  relativePath: NonEmptyText,
  absolutePath: NonEmptyText,
  kind: MediaSourceKind,
  fileSizeBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  modifiedAtMs: Schema.NullOr(UtcMillis),
  inode: Schema.NullOr(NonEmptyText),
  contentFingerprint: Schema.NullOr(NonEmptyText),
  scannedAtMs: UtcMillis,
});
export type MediaSource = Schema.Schema.Type<typeof MediaSource>;

export const Stream = Schema.Struct({
  id: Uuid,
  sourceId: Uuid,
  kind: StreamKind,
  container: Schema.NullOr(NonEmptyText),
  codec: Schema.NullOr(NonEmptyText),
  language: Schema.NullOr(NonEmptyText),
  isDefault: Schema.Boolean,
  bitrate: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sampleRateHz: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  channels: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  width: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  height: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type Stream = Schema.Schema.Type<typeof Stream>;

export const Chapter = Schema.Struct({
  id: Uuid,
  streamId: Uuid,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: NonEmptyText,
  startMs: DurationMillis,
  endMs: DurationMillis,
});
export type Chapter = Schema.Schema.Type<typeof Chapter>;

export const StreamSidecar = Schema.Struct({
  id: Uuid,
  streamId: Uuid,
  kind: SidecarKind,
  relativePath: NonEmptyText,
  mediaType: Schema.NullOr(NonEmptyText),
  contentHash: Sha256Digest,
});
export type StreamSidecar = Schema.Schema.Type<typeof StreamSidecar>;

export const Artist = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  name: NonEmptyText,
  normalizedName: NonEmptyText,
  sortName: Schema.NullOr(NonEmptyText),
  externalIdsJson: Schema.String,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type Artist = Schema.Schema.Type<typeof Artist>;

export const Album = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  title: NonEmptyText,
  normalizedTitle: NonEmptyText,
  albumArtistId: Schema.NullOr(Uuid),
  releaseDate: Schema.NullOr(NonEmptyText),
  originalReleaseDate: Schema.NullOr(NonEmptyText),
  releaseYear: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 }))),
  barcode: Schema.NullOr(NonEmptyText),
  externalIdsJson: Schema.String,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type Album = Schema.Schema.Type<typeof Album>;

export const Track = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  sourceId: Uuid,
  primaryStreamId: Uuid,
  albumId: Schema.NullOr(Uuid),
  title: NonEmptyText,
  normalizedTitle: NonEmptyText,
  trackNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  discNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  durationMs: Schema.NullOr(DurationMillis),
  isExplicit: Schema.Boolean,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type Track = Schema.Schema.Type<typeof Track>;

export const TrackArtist = Schema.Struct({
  trackId: Uuid,
  artistId: Uuid,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  role: Schema.Literals(["primary", "featured", "composer", "conductor", "remixer", "other"]),
});
export type TrackArtist = Schema.Schema.Type<typeof TrackArtist>;

export const AlbumArtist = Schema.Struct({
  albumId: Uuid,
  artistId: Uuid,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  role: Schema.Literals(["primary", "featured", "composer", "conductor", "remixer", "other"]),
});
export type AlbumArtist = Schema.Schema.Type<typeof AlbumArtist>;

export const TrackMetadata = Schema.Struct({
  trackId: Uuid,
  namespace: MetadataNamespace,
  key: NonEmptyText,
  valueJson: Schema.String,
  language: Schema.NullOr(NonEmptyText),
  sourceId: Schema.NullOr(Uuid),
  updatedAtMs: UtcMillis,
});
export type TrackMetadata = Schema.Schema.Type<typeof TrackMetadata>;

export const Artwork = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  sourceId: Schema.NullOr(Uuid),
  kind: Schema.Literals(["front", "back", "disc", "artist", "other"]),
  mimeType: NonEmptyText,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentHash: Sha256Digest,
  relativePath: NonEmptyText,
  createdAtMs: UtcMillis,
});
export type Artwork = Schema.Schema.Type<typeof Artwork>;

export const ArtworkAssignment = Schema.Struct({
  artworkId: Uuid,
  albumId: Schema.NullOr(Uuid),
  artistId: Schema.NullOr(Uuid),
  trackId: Schema.NullOr(Uuid),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isPrimary: Schema.Boolean,
});
export type ArtworkAssignment = Schema.Schema.Type<typeof ArtworkAssignment>;

export const CreateMediaSource = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  rootId: Uuid,
  relativePath: NonEmptyText,
  absolutePath: NonEmptyText,
  kind: MediaSourceKind,
  fileSizeBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  modifiedAtMs: Schema.NullOr(UtcMillis),
  inode: Schema.NullOr(NonEmptyText),
  contentFingerprint: Schema.NullOr(NonEmptyText),
  scannedAtMs: UtcMillis,
});
export type CreateMediaSource = Schema.Schema.Type<typeof CreateMediaSource>;

export const CreateTrack = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  sourceId: Uuid,
  primaryStreamId: Uuid,
  albumId: Schema.NullOr(Uuid),
  title: NonEmptyText,
  normalizedTitle: NonEmptyText,
  trackNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  discNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  durationMs: Schema.NullOr(DurationMillis),
  isExplicit: Schema.Boolean,
  nowMs: UtcMillis,
});
export type CreateTrack = Schema.Schema.Type<typeof CreateTrack>;

export const CreateStream = Schema.Struct({
  id: Uuid,
  sourceId: Uuid,
  kind: StreamKind,
  container: Schema.NullOr(NonEmptyText),
  codec: Schema.NullOr(NonEmptyText),
  language: Schema.NullOr(NonEmptyText),
  isDefault: Schema.Boolean,
  bitrate: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sampleRateHz: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  channels: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  width: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  height: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type CreateStream = Schema.Schema.Type<typeof CreateStream>;

export const CreateChapter = Schema.Struct({
  id: Uuid,
  streamId: Uuid,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: NonEmptyText,
  startMs: DurationMillis,
  endMs: DurationMillis,
});
export type CreateChapter = Schema.Schema.Type<typeof CreateChapter>;

export const CreateSidecar = Schema.Struct({
  id: Uuid,
  streamId: Uuid,
  kind: SidecarKind,
  relativePath: NonEmptyText,
  mediaType: Schema.NullOr(NonEmptyText),
  contentHash: Sha256Digest,
});
export type CreateSidecar = Schema.Schema.Type<typeof CreateSidecar>;

export const UpsertArtist = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  name: NonEmptyText,
  normalizedName: NonEmptyText,
  sortName: Schema.NullOr(NonEmptyText),
  externalIds: Schema.Record(Schema.String, Schema.String),
  nowMs: UtcMillis,
});
export type UpsertArtist = Schema.Schema.Type<typeof UpsertArtist>;

export const UpsertAlbum = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  title: NonEmptyText,
  normalizedTitle: NonEmptyText,
  albumArtistId: Schema.NullOr(Uuid),
  releaseDate: Schema.NullOr(NonEmptyText),
  originalReleaseDate: Schema.NullOr(NonEmptyText),
  releaseYear: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 }))),
  barcode: Schema.NullOr(NonEmptyText),
  externalIds: Schema.Record(Schema.String, Schema.String),
  nowMs: UtcMillis,
});
export type UpsertAlbum = Schema.Schema.Type<typeof UpsertAlbum>;

export const UpsertTrackMetadata = Schema.Struct({
  trackId: Uuid,
  namespace: MetadataNamespace,
  key: NonEmptyText,
  value: Schema.Unknown,
  language: Schema.NullOr(NonEmptyText),
  sourceId: Schema.NullOr(Uuid),
  nowMs: UtcMillis,
});
export type UpsertTrackMetadata = Schema.Schema.Type<typeof UpsertTrackMetadata>;

export const UpsertArtwork = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  sourceId: Schema.NullOr(Uuid),
  kind: Schema.Literals(["front", "back", "disc", "artist", "other"]),
  mimeType: NonEmptyText,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentHash: Sha256Digest,
  relativePath: NonEmptyText,
  nowMs: UtcMillis,
});
export type UpsertArtwork = Schema.Schema.Type<typeof UpsertArtwork>;

export const AssignArtwork = Schema.Struct({
  artworkId: Uuid,
  albumId: Schema.NullOr(Uuid),
  artistId: Schema.NullOr(Uuid),
  trackId: Schema.NullOr(Uuid),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isPrimary: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (value) =>
      [value.albumId, value.artistId, value.trackId].filter((id) => id !== null).length === 1,
  ),
);
export type AssignArtwork = Schema.Schema.Type<typeof AssignArtwork>;
