import { Schema } from "effect";
import { UtcMillis, Uuid } from "./schemas/common.ts";

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
