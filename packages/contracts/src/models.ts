import { Schema } from "effect";
import { UserRole, UtcMillis, Uuid } from "./schemas/common.ts";
import { TrackMemory } from "./track-memory.ts";
import { ServerInfo } from "./server.ts";

// Application models shared by every client. They describe what the apps render, independent of
// how a platform transports them (HTTP for the browser, IPC for the desktop renderer).

export const AccountSummary = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1)),
  serverId: Schema.String.check(Schema.isMinLength(1)),
  /** The name the server gives itself. */
  serverName: Schema.String.check(Schema.isMinLength(1)),
  origin: Schema.String.check(Schema.isMinLength(1)),
  username: Schema.String.check(Schema.isMinLength(1)),
  userId: Schema.String.check(Schema.isMinLength(1)),
  role: UserRole,
  secureStorageAvailable: Schema.Boolean,
  lastConnectedAtMs: Schema.NullOr(UtcMillis),
});
export type AccountSummary = Schema.Schema.Type<typeof AccountSummary>;

export const AccountList = Schema.Struct({
  accounts: Schema.Array(AccountSummary),
  activeConnectionId: Schema.NullOr(Schema.String),
});
export type AccountList = Schema.Schema.Type<typeof AccountList>;

export const ServerDiscovery = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1)),
  identity: ServerInfo,
  setupRequired: Schema.Boolean,
});
export type ServerDiscovery = Schema.Schema.Type<typeof ServerDiscovery>;

export const ConnectionInput = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  displayName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type ConnectionInput = Schema.Schema.Type<typeof ConnectionInput>;

export const LibrarySummary = Schema.Struct({
  id: Uuid,
  name: Schema.String.check(Schema.isMinLength(1)),
  slug: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.Literals(["movies", "shows", "music"]),
  isEnabled: Schema.Boolean,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type LibrarySummary = Schema.Schema.Type<typeof LibrarySummary>;

export const CatalogItem = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.String.check(Schema.isMinLength(1)),
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  year: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  artworkId: Schema.NullOr(Uuid),
  completed: Schema.optional(Schema.Boolean),
  resumePositionSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  parentId: Schema.optional(Schema.NullOr(Uuid)),
  seriesTitle: Schema.optional(Schema.NullOr(Schema.String)),
  seasonNumber: Schema.optional(Schema.NullOr(Schema.Int)),
  indexNumber: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type CatalogItem = Schema.Schema.Type<typeof CatalogItem>;

/** The episodes before and after one in its show. */
export const AdjacentEpisodes = Schema.Struct({
  previous: Schema.NullOr(CatalogItem),
  next: Schema.NullOr(CatalogItem),
});
export type AdjacentEpisodes = Schema.Schema.Type<typeof AdjacentEpisodes>;

export const CatalogItemDetails = Schema.Struct({
  item: Schema.Struct({
    id: Uuid,
    libraryId: Uuid,
    parentId: Schema.NullOr(Uuid),
    indexNumber: Schema.NullOr(Schema.Number),
    seriesTitle: Schema.optional(Schema.NullOr(Schema.String)),
    seasonNumber: Schema.optional(Schema.NullOr(Schema.Number)),
    title: Schema.String,
    kind: Schema.String,
    year: Schema.NullOr(Schema.Number),
    completed: Schema.optional(Schema.Boolean),
    durationSeconds: Schema.NullOr(Schema.Number),
    artworkId: Schema.NullOr(Uuid),
    overview: Schema.NullOr(Schema.String),
    releaseDate: Schema.NullOr(Schema.String),
    contentRating: Schema.NullOr(Schema.String),
    communityRating: Schema.NullOr(Schema.Number),
    genresJson: Schema.String,
    studiosJson: Schema.String,
    tagsJson: Schema.String,
    externalIdsJson: Schema.String,
    backdropId: Schema.NullOr(Uuid),
  }),
  sources: Schema.Array(Schema.Unknown),
  watchState: Schema.NullOr(
    Schema.Struct({
      positionSeconds: Schema.Number,
      completed: Schema.Boolean,
    }),
  ),
  isFavorite: Schema.Boolean,
  metadataProviderConfigured: Schema.Boolean,
});
export type CatalogItemDetails = Schema.Schema.Type<typeof CatalogItemDetails>;

export const CatalogItemPage = Schema.Struct({
  items: Schema.Array(CatalogItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CatalogItemPage = Schema.Schema.Type<typeof CatalogItemPage>;

export const PlayableStream = Schema.Struct({
  id: Uuid,
  kind: Schema.Literals(["audio", "subtitle"]),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  codec: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  channels: Schema.optional(Schema.NullOr(Schema.Number)),
  commentary: Schema.optional(Schema.NullOr(Schema.Boolean)),
  forced: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hearingImpaired: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type PlayableStream = Schema.Schema.Type<typeof PlayableStream>;

export const PlayerSession = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  sourceId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  streamUrl: Schema.String.check(Schema.isMinLength(1)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  streams: Schema.Array(PlayableStream),
  grantExpiresInSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  grantToken: Schema.String.check(Schema.isMinLength(1)),
  trackMemory: Schema.optional(TrackMemory),
});
export type PlayerSession = Schema.Schema.Type<typeof PlayerSession>;

export const AudioOutput = Schema.Literals(["stereo", "auto-safe"]);
export type AudioOutput = Schema.Schema.Type<typeof AudioOutput>;

/** How loud a viewer left the player, which a client keeps for whatever it plays next. */
export const VolumeSettings = Schema.Struct({
  volume: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
});
export type VolumeSettings = Schema.Schema.Type<typeof VolumeSettings>;

export const BufferedRange = Schema.Struct({
  startSeconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  endSeconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BufferedRange = Schema.Schema.Type<typeof BufferedRange>;

export const PlayerState = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  paused: Schema.Boolean,
  positionSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bufferedRanges: Schema.Array(BufferedRange),
  ...VolumeSettings.fields,
  ended: Schema.Boolean,
  streams: Schema.Array(PlayableStream),
  selectedAudioStreamId: Schema.NullOr(Uuid),
  selectedSubtitleStreamId: Schema.NullOr(Uuid),
  audioOutput: AudioOutput,
  trackMemoryError: Schema.optional(Schema.NullOr(Schema.String)),
  /** Playback stalled waiting for data. */
  buffering: Schema.optional(Schema.Boolean),
  /** The platform refuses to start playback until the viewer interacts with the player. */
  awaitingInteraction: Schema.optional(Schema.Boolean),
});
export type PlayerState = Schema.Schema.Type<typeof PlayerState>;

export const PlayerDisplay = Schema.Struct({
  title: Schema.String,
  context: Schema.String,
  duration: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  hasPreviousEpisode: Schema.Boolean,
  /** The episode after the one playing, where there is one. */
  nextEpisode: Schema.NullOr(
    Schema.Struct({
      title: Schema.String,
      /** Its place in the show, such as "S01E03"; empty where that is not known. */
      context: Schema.String,
      artworkId: Schema.NullOr(Uuid),
    }),
  ),
});
export type PlayerDisplay = Schema.Schema.Type<typeof PlayerDisplay>;

/** What the viewer asked of the player controls that the application has to carry out. */
export const PlayerAction = Schema.Literals([
  "back",
  "retry",
  "stop",
  "previous-episode",
  "next-episode",
]);
export type PlayerAction = Schema.Schema.Type<typeof PlayerAction>;
