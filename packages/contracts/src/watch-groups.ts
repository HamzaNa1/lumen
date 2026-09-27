import { Schema } from "effect";
import { Uuid } from "./schemas/common.ts";

const Position = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 604800 }),
);
const Password = Schema.String.check(Schema.isMaxLength(128));
export const WatchPlayback = Schema.Struct({
  itemId: Uuid,
  title: Schema.String,
  positionSeconds: Position,
  paused: Schema.Boolean,
  updatedAtMs: Schema.Number,
});
export type WatchPlayback = typeof WatchPlayback.Type;
export const WatchGroup = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  hasPassword: Schema.Boolean,
  members: Schema.Array(Schema.Struct({ id: Uuid, displayName: Schema.String })),
  playback: Schema.NullOr(WatchPlayback),
  revision: Schema.Int,
});
export type WatchGroup = typeof WatchGroup.Type;
export const WatchAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({
    type: Schema.Literal("create"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
    password: Password,
  }),
  Schema.Struct({ type: Schema.Literal("join"), groupId: Uuid, password: Password }),
  Schema.Struct({ type: Schema.Literal("leave") }),
  Schema.Struct({ type: Schema.Literal("play"), itemId: Uuid, positionSeconds: Position }),
  Schema.Struct({
    type: Schema.Literal("pause"),
    itemId: Uuid,
    paused: Schema.Boolean,
    positionSeconds: Position,
  }),
  Schema.Struct({ type: Schema.Literal("seek"), itemId: Uuid, positionSeconds: Position }),
  Schema.Struct({ type: Schema.Literal("stop"), itemId: Uuid }),
  Schema.Struct({ type: Schema.Literal("ping"), sentAtMs: Schema.Number.check(Schema.isFinite()) }),
]);
export type WatchAction = typeof WatchAction.Type;
export const WatchRequest = Schema.Struct({ requestId: Uuid, action: WatchAction });
export const WatchMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), memberId: Uuid }),
  Schema.Struct({ type: Schema.Literal("groups"), groups: Schema.Array(WatchGroup) }),
  Schema.Struct({ type: Schema.Literal("state"), group: Schema.NullOr(WatchGroup) }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    requestId: Uuid,
    error: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("pong"),
    sentAtMs: Schema.Number,
    serverTimeMs: Schema.Number,
  }),
]);
export type WatchMessage = typeof WatchMessage.Type;
export interface WatchStatus {
  readonly connection: "offline" | "connecting" | "connected";
  readonly memberId: string | null;
  readonly groups: ReadonlyArray<WatchGroup>;
  readonly group: WatchGroup | null;
  readonly error: string | null;
}

export const watchPosition = (playback: WatchPlayback, nowMs: number): number =>
  Math.min(
    604800,
    playback.positionSeconds +
      (playback.paused ? 0 : Math.max(0, nowMs - playback.updatedAtMs) / 1000),
  );

export const watchCorrection = (
  positionSeconds: number,
  targetSeconds: number,
  paused: boolean,
): { readonly seek: number | null; readonly speed: number } => {
  const drift = targetSeconds - positionSeconds;
  if (Math.abs(drift) >= 1 || (paused && Math.abs(drift) > 0.08))
    return { seek: targetSeconds, speed: 1 };
  return { seek: null, speed: paused || Math.abs(drift) <= 0.08 ? 1 : drift > 0 ? 1.05 : 0.95 };
};
