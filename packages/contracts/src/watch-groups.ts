import { Schema } from "effect";
import { Uuid } from "./schemas/common.ts";

const Position = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 604800 }),
);
const Password = Schema.String.check(Schema.isMaxLength(128));
export const WATCH_HEARTBEAT_INTERVAL_MS = 5000;
/** Application messages, rather than WebSocket control frames, keep a member alive. */
export const WATCH_MEMBER_TIMEOUT_MS = 30_000;
/** A superseded connection must not reconnect and evict its successor. */
export const WATCH_CONNECTION_REPLACED = 4001;
const WatchAbilities = {
  readiness: Schema.optional(Schema.Boolean),
  buffers: Schema.optional(Schema.Boolean),
  /** Unique to one WatchGroupClient, retained across its reconnects; absent on older clients. */
  clientId: Schema.optional(Uuid),
  /** Resume only this membership. An explicit leave clears the client's resume intent. */
  resumeGroupId: Schema.optional(Uuid),
};
export const WatchConnect = Schema.Union([
  Schema.Struct({
    token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    ...WatchAbilities,
  }),
  Schema.Struct({ session: Schema.Literal("cookie"), ...WatchAbilities }),
]);

/** How much media a member must hold beyond the group's position before the group plays on. */
export const WATCH_READY_BUFFER_SECONDS = 5;
/** How often a member's player says how it is buffered, while it has the group's media on. */
export const WATCH_BUFFER_REPORT_INTERVAL_MS = 2000;
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
/** What a member's player holds of the group's media beyond where it is playing. */
const WatchBuffer = {
  aheadSeconds: Position,
  /** That is all the media there is left: the player has nothing more to fetch. */
  toEnd: Schema.Boolean,
};
export const WatchMemberBuffer = Schema.Struct({ memberId: Uuid, ...WatchBuffer });
export type WatchMemberBuffer = typeof WatchMemberBuffer.Type;
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
  Schema.Struct({
    type: Schema.Literal("play"),
    itemId: Uuid,
    positionSeconds: Position,
    /** Display hint for local prediction; the server resolves the authoritative catalog title. */
    title: Schema.optional(Schema.String),
    /**
     * What the member was watching when they asked. The group plays only while it still has
     * that on: every member's player reaches the end of an episode, and each asks for the next.
     */
    replaces: Schema.optional(Uuid),
  }),
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
  /** How this member's player is buffered for the item the group has on. */
  Schema.Struct({ type: Schema.Literal("buffer"), itemId: Uuid, ...WatchBuffer }),
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
    /** Whether this server takes the `buffer` action and tells members how each is buffered. */
    sharesBuffers: Schema.optional(Schema.Boolean),
    /** The name this member goes by in a group. Servers before 0.0.14 do not say. */
    displayName: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("groups"), groups: Schema.Array(WatchGroup) }),
  Schema.Struct({ type: Schema.Literal("state"), group: Schema.NullOr(WatchGroup) }),
  /** Sent only to clients that asked for it; one that predates it would hang up. */
  Schema.Struct({ type: Schema.Literal("buffers"), buffers: Schema.Array(WatchMemberBuffer) }),
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
  /** How the group's members are buffered, for those whose players have lately said. */
  readonly buffers: ReadonlyArray<WatchMemberBuffer>;
  readonly error: string | null;
}

export const initialWatchStatus = (): WatchStatus => ({
  connection: "offline",
  memberId: null,
  groups: [],
  group: null,
  buffers: [],
  error: null,
});

export const watchPosition = (playback: WatchPlayback, nowMs: number): number =>
  Math.min(
    604800,
    playback.positionSeconds +
      (playback.paused ? 0 : Math.max(0, nowMs - playback.updatedAtMs) / 1000),
  );
