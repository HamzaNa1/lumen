import type {
  CreateDevice,
  CreateLibrary,
  CreateMediaSource,
  CreateStream,
  CreateTrack,
  CreateUser,
  UpsertAlbum,
  UpsertArtist,
} from "@lumen/contracts";
import { digests, ids, times } from "./ids";

export const fixtures = {
  createUser: {
    id: ids.user,
    username: "Ada Lovelace",
    usernameNormalized: "ada",
    displayName: "Ada Lovelace",
    passwordHash: digests.password,
    role: "admin",
    nowMs: times.epochMs,
  },
  createDevice: {
    id: ids.device,
    userId: ids.user,
    name: "Test Browser",
    platform: "web",
    platformDeviceId: "browser-1",
    nowMs: times.epochMs,
  },
  createLibrary: {
    id: ids.library,
    name: "Main Library",
    slug: "main-library",
    nowMs: times.epochMs,
  },
  createSource: {
    id: ids.source,
    libraryId: ids.library,
    rootId: ids.libraryRoot,
    relativePath: "Artist/Album/Track.flac",
    absolutePath: "/media/main/Artist/Album/Track.flac",
    kind: "local",
    fileSizeBytes: 4_096,
    modifiedAtMs: times.epochMs,
    inode: "inode-1",
    contentFingerprint: "fingerprint-1",
    scannedAtMs: times.epochMs,
  },
  createStream: {
    id: ids.stream,
    sourceId: ids.source,
    kind: "audio",
    container: "flac",
    codec: "flac",
    language: null,
    title: null,
    ordinal: 0,
    isDefault: true,
    bitrate: 900_000,
    sampleRateHz: 44_100,
    channels: 2,
    width: null,
    height: null,
  },
  createArtist: {
    id: ids.artist,
    libraryId: ids.library,
    name: "The Example Artist",
    normalizedName: "the example artist",
    sortName: "Example Artist, The",
    externalIds: { musicbrainz: "artist-1" },
    nowMs: times.epochMs,
  },
  createAlbum: {
    id: ids.album,
    libraryId: ids.library,
    title: "Deterministic Album",
    normalizedTitle: "deterministic album",
    albumArtistId: ids.artist,
    releaseDate: "2024-01-02",
    originalReleaseDate: "2024-01-02",
    releaseYear: 2024,
    barcode: "0000000000000",
    externalIds: { musicbrainz: "album-1" },
    nowMs: times.epochMs,
  },
  createTrack: {
    id: ids.track,
    libraryId: ids.library,
    sourceId: ids.source,
    primaryStreamId: ids.stream,
    albumId: ids.album,
    title: "Deterministic Track",
    normalizedTitle: "deterministic track",
    trackNumber: 1,
    discNumber: 1,
    durationMs: 245_000,
    isExplicit: false,
    nowMs: times.epochMs,
  },
} as const satisfies {
  readonly createUser: CreateUser;
  readonly createDevice: CreateDevice;
  readonly createLibrary: CreateLibrary;
  readonly createSource: CreateMediaSource;
  readonly createStream: CreateStream;
  readonly createArtist: UpsertArtist;
  readonly createAlbum: UpsertAlbum;
  readonly createTrack: CreateTrack;
};
