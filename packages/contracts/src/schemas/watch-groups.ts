import { Schema } from "effect";
import { Uuid } from "./common.ts";

export const PlaybackMilliseconds = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const PlaybackSeconds = PlaybackMilliseconds;
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Version = Schema.Literal(1);
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);
const Password = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const GroupMedia = Schema.Struct({
  itemId: Uuid,
  trackId: Uuid,
  sourceId: Uuid,
  sourceGeneration: Revision.check(Schema.isGreaterThan(0)),
  durationMs: Schema.NullOr(PlaybackMilliseconds),
});
export type GroupMedia = typeof GroupMedia.Type;
export const GroupPlayback = Schema.Struct({
  serverInstanceId: Uuid,
  groupId: Uuid,
  revision: Revision,
  alignmentRevision: Revision,
  playbackId: Uuid,
  media: Schema.NullOr(GroupMedia),
  mode: Schema.Literals(["stopped", "playing", "paused", "ended"]),
  anchorPositionMs: PlaybackMilliseconds,
  anchorServerTimeMs: PlaybackMilliseconds,
}).check(
  Schema.makeFilter(
    (s) =>
      s.alignmentRevision <= s.revision &&
      (s.mode === "stopped"
        ? s.media === null && s.anchorPositionMs === 0
        : s.media !== null &&
          (s.media.durationMs === null || s.anchorPositionMs <= s.media.durationMs)),
  ),
);
export type GroupPlayback = typeof GroupPlayback.Type;
export const GroupAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), itemId: Uuid, positionMs: PlaybackMilliseconds }),
  Schema.Struct({ type: Schema.Literal("set-paused"), paused: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("seek"), positionMs: PlaybackMilliseconds }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type GroupAction = typeof GroupAction.Type;
export const GroupCommand = Schema.Struct({
  protocolVersion: Version,
  commandId: Uuid,
  expectedRevision: Revision,
  expectedPlaybackId: Uuid,
  action: GroupAction,
});
export type GroupCommand = typeof GroupCommand.Type;
export const GroupMemberStatus = Schema.Literals([
  "connecting",
  "ready",
  "buffering",
  "blocked",
  "failed",
]);
export type GroupMemberStatus = typeof GroupMemberStatus.Type;
const Member = Schema.Struct({
  membershipId: Uuid,
  displayName: Schema.String.check(Schema.isMaxLength(200)),
  connected: Schema.Boolean,
  status: GroupMemberStatus,
});
export const GroupPlaybackView = Schema.Union([
  Schema.Struct({ type: Schema.Literal("playback"), state: GroupPlayback }),
  Schema.Struct({
    type: Schema.Literal("playback-access-denied"),
    revision: Revision,
    playbackId: Uuid,
  }),
]);
export const GroupSnapshot = Schema.Struct({
  serverInstanceId: Uuid,
  groupId: Uuid,
  name: Name,
  membershipId: Uuid,
  rosterRevision: Revision,
  members: Schema.Array(Member).check(Schema.isMaxLength(32)),
  playback: GroupPlaybackView,
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.playback.type !== "playback" ||
      (snapshot.playback.state.serverInstanceId === snapshot.serverInstanceId &&
        snapshot.playback.state.groupId === snapshot.groupId),
  ),
);
export type GroupSnapshot = typeof GroupSnapshot.Type;
export const GroupSummary = Schema.Struct({
  groupId: Uuid,
  name: Name,
  memberCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
  passwordRequired: Schema.Boolean,
});
export const GroupList = Schema.Struct({
  groups: Schema.Array(GroupSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(Uuid),
});
export type GroupList = typeof GroupList.Type;
export const CreateWatchGroup = Schema.Struct({
  name: Name,
  password: Schema.optional(Password),
  idempotencyKey: Uuid,
});
export type CreateWatchGroup = typeof CreateWatchGroup.Type;
export const JoinWatchGroup = Schema.Struct({ password: Schema.optional(Password) });
export type JoinWatchGroup = typeof JoinWatchGroup.Type;
export const GroupPlaybackRequest = Schema.Struct({ expectedPlaybackId: Uuid });
export const GroupTicket = Schema.Struct({
  ticket: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
  serverInstanceId: Uuid,
});
export const GroupErrorCode = Schema.Literals([
  "stale_state",
  "unavailable_media",
  "denied",
  "membership_expired",
  "rate_limited",
  "capacity",
  "invalid_command",
  "server_restarted",
  "unavailable",
]);
export type GroupErrorCode = typeof GroupErrorCode.Type;
export const GroupCommandResult = Schema.Struct({
  commandId: Uuid,
  outcome: Schema.Literals(["accepted", "rejected"]),
  code: Schema.NullOr(GroupErrorCode),
  revision: Revision,
  snapshot: GroupSnapshot,
});
export type GroupCommandResult = typeof GroupCommandResult.Type;
export const GroupClientFrame = Schema.Union([
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("authenticate"),
    ticket: GroupTicket.fields.ticket,
  }),
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("command"),
    command: GroupCommand,
  }),
  Schema.Struct({ protocolVersion: Version, type: Schema.Literal("clock-ping"), probeId: Uuid }),
  Schema.Struct({ protocolVersion: Version, type: Schema.Literal("request-snapshot") }),
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("member-status"),
    status: GroupMemberStatus,
  }),
]);
export type GroupClientFrame = typeof GroupClientFrame.Type;
export const GroupServerFrame = Schema.Union([
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("snapshot"),
    snapshot: GroupSnapshot,
  }),
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("command-result"),
    result: GroupCommandResult,
  }),
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("clock-pong"),
    probeId: Uuid,
    serverInstanceId: Uuid,
    t1: PlaybackMilliseconds,
    t2: PlaybackMilliseconds,
  }),
  Schema.Struct({
    protocolVersion: Version,
    type: Schema.Literal("membership-ended"),
    code: GroupErrorCode,
  }),
  Schema.Struct({ protocolVersion: Version, type: Schema.Literal("error"), code: GroupErrorCode }),
]);
export type GroupServerFrame = typeof GroupServerFrame.Type;
export const IpcWatchGroupState = Schema.Struct({
  connectionId: Uuid,
  status: Schema.Literals([
    "connecting",
    "synchronizing",
    "ready",
    "reconnecting",
    "blocked",
    "failed",
    "ended",
  ]),
  snapshot: Schema.NullOr(GroupSnapshot),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
});
export type IpcWatchGroupState = typeof IpcWatchGroupState.Type;
export const IpcJoinWatchGroup = Schema.Struct({
  groupId: Uuid,
  password: Schema.optional(Password),
});
