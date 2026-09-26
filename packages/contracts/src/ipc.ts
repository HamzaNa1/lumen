import { Schema } from "effect";
import { UserRole, UtcMillis, Uuid } from "./schemas/common.ts";

export const IpcLogin = Schema.Struct({
  _tag: Schema.Literal("auth.login"),
  username: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
  platformDeviceId: Schema.NullOr(Schema.String),
  nowMs: UtcMillis,
});
export type IpcLogin = Schema.Schema.Type<typeof IpcLogin>;

export const IpcLogout = Schema.Struct({
  _tag: Schema.Literal("auth.logout"),
  sessionId: Uuid,
  nowMs: UtcMillis,
});
export type IpcLogout = Schema.Schema.Type<typeof IpcLogout>;

export const IpcSearchCatalog = Schema.Struct({
  _tag: Schema.Literal("catalog.search"),
  query: Schema.String.check(Schema.isMinLength(1)),
  libraryId: Schema.NullOr(Uuid),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type IpcSearchCatalog = Schema.Schema.Type<typeof IpcSearchCatalog>;

export const IpcStartPlayback = Schema.Struct({
  _tag: Schema.Literal("playback.start"),
  trackId: Schema.NullOr(Uuid),
  nowMs: UtcMillis,
  expiresAtMs: UtcMillis,
});
export type IpcStartPlayback = Schema.Schema.Type<typeof IpcStartPlayback>;

export const IpcPlaybackProgress = Schema.Struct({
  _tag: Schema.Literal("playback.progress"),
  trackId: Uuid,
  positionMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nowMs: UtcMillis,
});
export type IpcPlaybackProgress = Schema.Schema.Type<typeof IpcPlaybackProgress>;

export const IpcAccount = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1)),
  serverId: Schema.String.check(Schema.isMinLength(1)),
  serverLabel: Schema.String.check(Schema.isMinLength(1)),
  origin: Schema.String.check(Schema.isMinLength(1)),
  username: Schema.String.check(Schema.isMinLength(1)),
  userId: Schema.String.check(Schema.isMinLength(1)),
  role: UserRole,
  secureStorageAvailable: Schema.Boolean,
  lastConnectedAtMs: Schema.NullOr(UtcMillis),
});
export type IpcAccount = Schema.Schema.Type<typeof IpcAccount>;

export const IpcAccounts = Schema.Struct({
  accounts: Schema.Array(IpcAccount),
  activeConnectionId: Schema.NullOr(Schema.String),
});
export type IpcAccounts = Schema.Schema.Type<typeof IpcAccounts>;

export const IpcServerDiscovery = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1)),
  identity: Schema.Struct({
    serverId: Schema.String.check(Schema.isMinLength(1)),
    displayName: Schema.String.check(Schema.isMinLength(1)),
    apiVersion: Schema.String.check(Schema.isMinLength(1)),
    setupRequired: Schema.optional(Schema.Boolean),
  }),
  setupRequired: Schema.Boolean,
});
export type IpcServerDiscovery = Schema.Schema.Type<typeof IpcServerDiscovery>;

export const IpcConnectionInput = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  displayName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  serverLabel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  signUp: Schema.optional(Schema.Boolean),
});
export type IpcConnectionInput = Schema.Schema.Type<typeof IpcConnectionInput>;

export const IpcLibrary = Schema.Struct({
  id: Uuid,
  name: Schema.String.check(Schema.isMinLength(1)),
  slug: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.Literals(["movies", "shows", "music"]),
  isEnabled: Schema.Boolean,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type IpcLibrary = Schema.Schema.Type<typeof IpcLibrary>;

export const IpcItem = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.String.check(Schema.isMinLength(1)),
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  year: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  artworkId: Schema.NullOr(Uuid),
  resumePositionSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  parentId: Schema.optional(Schema.NullOr(Uuid)),
  indexNumber: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type IpcItem = Schema.Schema.Type<typeof IpcItem>;

export const IpcItemDetails = Schema.Struct({
  item: Schema.Struct({
    id: Uuid,
    libraryId: Uuid,
    parentId: Schema.NullOr(Uuid),
    indexNumber: Schema.NullOr(Schema.Number),
    title: Schema.String,
    kind: Schema.String,
    year: Schema.NullOr(Schema.Number),
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
  watchState: Schema.NullOr(Schema.Unknown),
  isFavorite: Schema.Boolean,
  metadataProviderConfigured: Schema.Boolean,
});
export type IpcItemDetails = Schema.Schema.Type<typeof IpcItemDetails>;

export const IpcItemPage = Schema.Struct({
  items: Schema.Array(IpcItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type IpcItemPage = Schema.Schema.Type<typeof IpcItemPage>;

export const IpcPlayableStream = Schema.Struct({
  id: Uuid,
  kind: Schema.Literals(["audio", "subtitle"]),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  codec: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
});
export type IpcPlayableStream = Schema.Schema.Type<typeof IpcPlayableStream>;

export const IpcPlayerSession = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  sourceId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  streamUrl: Schema.String.check(Schema.isMinLength(1)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  streams: Schema.Array(IpcPlayableStream),
  grantExpiresInSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  grantToken: Schema.String.check(Schema.isMinLength(1)),
});
export type IpcPlayerSession = Schema.Schema.Type<typeof IpcPlayerSession>;

export const IpcAudioOutput = Schema.Literals(["stereo", "auto-safe"]);
export type IpcAudioOutput = Schema.Schema.Type<typeof IpcAudioOutput>;

export const IpcPlayerState = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  paused: Schema.Boolean,
  positionSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  volume: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
  ended: Schema.Boolean,
  streams: Schema.Array(IpcPlayableStream),
  selectedAudioStreamId: Schema.NullOr(Uuid),
  selectedSubtitleStreamId: Schema.NullOr(Uuid),
  audioOutput: IpcAudioOutput,
});
export type IpcPlayerState = Schema.Schema.Type<typeof IpcPlayerState>;

export const IpcPlayerDisplay = Schema.Struct({
  title: Schema.String,
  context: Schema.String,
  duration: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type IpcPlayerDisplay = Schema.Schema.Type<typeof IpcPlayerDisplay>;

export const IpcPlayerSurfaceBounds = Schema.Struct({
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type IpcPlayerSurfaceBounds = Schema.Schema.Type<typeof IpcPlayerSurfaceBounds>;

export const IpcRequest = Schema.Union([
  IpcLogin,
  IpcLogout,
  IpcSearchCatalog,
  IpcStartPlayback,
  IpcPlaybackProgress,
]);
export type IpcRequest = Schema.Schema.Type<typeof IpcRequest>;
