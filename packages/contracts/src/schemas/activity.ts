import { Schema } from "effect";
import { DurationMillis, Sha256Digest, UtcMillis, Uuid } from "./common";

export const PlaybackState = Schema.Literals([
  "idle",
  "playing",
  "paused",
  "buffering",
  "ended",
  "error",
]);

export const WatchState = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  trackId: Uuid,
  positionMs: DurationMillis,
  completed: Schema.Boolean,
  updatedAtMs: UtcMillis,
});
export type WatchState = Schema.Schema.Type<typeof WatchState>;

export const Favorite = Schema.Struct({
  userId: Uuid,
  trackId: Uuid,
  createdAtMs: UtcMillis,
});
export type Favorite = Schema.Schema.Type<typeof Favorite>;

export const PlaybackSession = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  deviceId: Uuid,
  state: PlaybackState,
  grantTokenHash: Sha256Digest,
  activeTrackId: Schema.NullOr(Uuid),
  startedAtMs: UtcMillis,
  lastSeenAtMs: UtcMillis,
  expiresAtMs: UtcMillis,
  closedAtMs: Schema.NullOr(UtcMillis),
  errorCode: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/))),
});
export type PlaybackSession = Schema.Schema.Type<typeof PlaybackSession>;

export const PlaybackGrant = Schema.Struct({
  id: Uuid,
  sessionId: Uuid,
  trackId: Uuid,
  canSeek: Schema.Boolean,
  canSkip: Schema.Boolean,
  maxBitrateKbps: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  expiresAtMs: UtcMillis,
});
export type PlaybackGrant = Schema.Schema.Type<typeof PlaybackGrant>;

export const PlaybackProgress = Schema.Struct({
  sessionId: Uuid,
  trackId: Uuid,
  positionMs: DurationMillis,
  durationMs: Schema.NullOr(DurationMillis),
  updatedAtMs: UtcMillis,
});
export type PlaybackProgress = Schema.Schema.Type<typeof PlaybackProgress>;

export const UpsertWatchState = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  trackId: Uuid,
  positionMs: DurationMillis,
  completed: Schema.Boolean,
  nowMs: UtcMillis,
});
export type UpsertWatchState = Schema.Schema.Type<typeof UpsertWatchState>;

export const SetFavorite = Schema.Struct({
  userId: Uuid,
  trackId: Uuid,
  isFavorite: Schema.Boolean,
  nowMs: UtcMillis,
});
export type SetFavorite = Schema.Schema.Type<typeof SetFavorite>;

export const StartPlayback = Schema.Struct({
  sessionId: Uuid,
  userId: Uuid,
  deviceId: Uuid,
  grantTokenHash: Sha256Digest,
  activeTrackId: Schema.NullOr(Uuid),
  nowMs: UtcMillis,
  expiresAtMs: UtcMillis,
});
export type StartPlayback = Schema.Schema.Type<typeof StartPlayback>;

export const UpdatePlaybackProgress = Schema.Struct({
  sessionId: Uuid,
  trackId: Uuid,
  positionMs: DurationMillis,
  durationMs: Schema.NullOr(DurationMillis),
  nowMs: UtcMillis,
});
export type UpdatePlaybackProgress = Schema.Schema.Type<typeof UpdatePlaybackProgress>;
