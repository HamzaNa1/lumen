import { Schema } from "effect";
import { Uuid } from "./schemas/common";

const Position = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Password = Schema.String.check(Schema.isMaxLength(128));
export const CreateWatchGroup = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  password: Schema.optional(Password),
});
export type CreateWatchGroup = Schema.Schema.Type<typeof CreateWatchGroup>;
export const JoinWatchGroup = Schema.Struct({ password: Schema.optional(Password) });
export const WatchGroupCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), itemId: Uuid, positionSeconds: Position }),
  Schema.Struct({ type: Schema.Literal("pause"), playbackId: Uuid }),
  Schema.Struct({ type: Schema.Literal("resume"), playbackId: Uuid }),
  Schema.Struct({ type: Schema.Literal("seek"), playbackId: Uuid, positionSeconds: Position }),
  Schema.Struct({ type: Schema.Literal("stop"), playbackId: Uuid }),
]);
export type WatchGroupCommand = Schema.Schema.Type<typeof WatchGroupCommand>;
export const WatchGroupPlayback = Schema.Struct({
  id: Uuid,
  itemId: Uuid,
  title: Schema.String,
  positionSeconds: Position,
  durationSeconds: Schema.NullOr(Position),
  paused: Schema.Boolean,
  updatedAtMs: Schema.Number,
  revision: Schema.Int,
});
export type WatchGroupPlayback = Schema.Schema.Type<typeof WatchGroupPlayback>;
export const WatchGroupSummary = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  passwordProtected: Schema.Boolean,
  members: Schema.Array(Schema.Struct({ id: Uuid, displayName: Schema.String })),
});
export type WatchGroupSummary = Schema.Schema.Type<typeof WatchGroupSummary>;
export const WatchGroup = Schema.Struct({
  ...WatchGroupSummary.fields,
  revision: Schema.Int,
  playback: Schema.NullOr(WatchGroupPlayback),
});
export type WatchGroup = Schema.Schema.Type<typeof WatchGroup>;
export const WatchGroupSnapshot = Schema.Struct({
  group: Schema.NullOr(WatchGroup),
  serverTimeMs: Schema.Number,
});
export type WatchGroupSnapshot = Schema.Schema.Type<typeof WatchGroupSnapshot>;
export interface WatchGroupStatus {
  readonly group: WatchGroup | null;
  readonly error: string | null;
  readonly connected: boolean;
}

export const watchGroupPosition = (playback: WatchGroupPlayback, nowMs: number): number => {
  const position =
    playback.positionSeconds +
    (playback.paused ? 0 : Math.max(0, nowMs - playback.updatedAtMs) / 1_000);
  return Math.min(position, playback.durationSeconds ?? Number.POSITIVE_INFINITY);
};
