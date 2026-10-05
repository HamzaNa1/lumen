import { Schema } from "effect";
import { Uuid } from "./schemas/common.ts";

const Position = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 604800 }),
);
const Password = Schema.String.check(Schema.isMaxLength(128));
/** How much media a member must hold beyond the group's position before the group plays on. */
export const WATCH_READY_BUFFER_SECONDS = 5;
export const WatchPlayback = Schema.Struct({
  itemId: Uuid,
  title: Schema.String,
  positionSeconds: Position,
  paused: Schema.Boolean,
  updatedAtMs: Schema.Number,
  /**
   * Present while the group holds at this position so its members can buffer it, naming the
   * members it is still waiting for. A held group is paused; it plays once the wait is over.
   */
  waitingFor: Schema.optional(Schema.Array(Uuid)),
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
  /** This member no longer needs the group, as it stood at that revision, to wait for it. */
  Schema.Struct({ type: Schema.Literal("ready"), revision: Schema.Int }),
  /** This member ran out of media to play; the group, as it stood at that revision, holds for it. */
  Schema.Struct({ type: Schema.Literal("buffering"), revision: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("ping"), sentAtMs: Schema.Number.check(Schema.isFinite()) }),
]);
export type WatchAction = typeof WatchAction.Type;
export const WatchRequest = Schema.Struct({ requestId: Uuid, action: WatchAction });
export const WatchMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    memberId: Uuid,
    /** Whether this server takes the `buffering` action; one that predates it would hang up. */
    holdsForBuffering: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("groups"), groups: Schema.Array(WatchGroup) }),
  Schema.Struct({ type: Schema.Literal("state"), group: Schema.NullOr(WatchGroup) }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    requestId: Uuid,
    error: Schema.NullOr(Schema.String),
    retryAfterMs: Schema.optional(
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("pong"),
    sentAtMs: Schema.Number,
    serverTimeMs: Schema.Number,
  }),
]);
export type WatchMessage = typeof WatchMessage.Type;
export interface WatchStatus {
  readonly connection: "offline" | "connecting" | "connected" | "unavailable";
  readonly memberId: string | null;
  readonly groups: ReadonlyArray<WatchGroup>;
  readonly group: WatchGroup | null;
  readonly error: string | null;
}

export const initialWatchStatus = (): WatchStatus => ({
  connection: "offline",
  memberId: null,
  groups: [],
  group: null,
  error: null,
});

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
