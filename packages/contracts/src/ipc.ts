import { Schema } from "effect";
import { UtcMillis, Uuid } from "./schemas/common";

export const IpcLogin = Schema.Struct({
  _tag: Schema.Literal("auth.login"),
  username: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
  platformDeviceId: Schema.NullOr(Schema.String),
  nowMs: UtcMillis,
});
export type IpcLogin = Schema.Schema.Type<typeof IpcLogin>;

export const IpcRefresh = Schema.Struct({
  _tag: Schema.Literal("auth.refresh"),
  refreshToken: Schema.String.check(Schema.isMinLength(1)),
  nowMs: UtcMillis,
});
export type IpcRefresh = Schema.Schema.Type<typeof IpcRefresh>;

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
  deviceId: Uuid,
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
  secureStorageAvailable: Schema.Boolean,
  lastConnectedAtMs: Schema.NullOr(UtcMillis),
});
export type IpcAccount = Schema.Schema.Type<typeof IpcAccount>;

export const IpcAccounts = Schema.Struct({
  accounts: Schema.Array(IpcAccount),
  activeConnectionId: Schema.NullOr(Schema.String),
});
export type IpcAccounts = Schema.Schema.Type<typeof IpcAccounts>;

export const IpcConnectionInput = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  serverLabel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
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
});
export type IpcItem = Schema.Schema.Type<typeof IpcItem>;

export const IpcItemPage = Schema.Struct({
  items: Schema.Array(IpcItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type IpcItemPage = Schema.Schema.Type<typeof IpcItemPage>;

export const IpcPlayerSession = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  sourceId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  streamUrl: Schema.String.check(Schema.isMinLength(1)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  grantExpiresInSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  grantToken: Schema.String.check(Schema.isMinLength(1)),
});
export type IpcPlayerSession = Schema.Schema.Type<typeof IpcPlayerSession>;

export const IpcPlayerState = Schema.Struct({
  sessionId: Uuid,
  itemId: Uuid,
  paused: Schema.Boolean,
  positionSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  volume: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
  ended: Schema.Boolean,
});
export type IpcPlayerState = Schema.Schema.Type<typeof IpcPlayerState>;

export const IpcRequest = Schema.Union([
  IpcLogin,
  IpcRefresh,
  IpcLogout,
  IpcSearchCatalog,
  IpcStartPlayback,
  IpcPlaybackProgress,
]);
export type IpcRequest = Schema.Schema.Type<typeof IpcRequest>;
