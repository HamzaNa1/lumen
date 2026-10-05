import type { WatchAction, WatchGroup, WatchPlayback, WatchStatus } from "@lumen/contracts";
import { randomId } from "../ids.ts";

/** What a client knows about its own viewer when it predicts what an action will do. */
export interface WatchViewer {
  readonly memberId: string;
  /** Null when the server did not say; the viewer cannot then be shown as a member in advance. */
  readonly displayName: string | null;
  /** Whether groups hold for this client to load, as they do for any client that reports back. */
  readonly readiness: boolean;
}

/**
 * What a viewer's own action is expected to do to their group. It is shown from the moment the
 * action is sent, and stands in only until the server's own account of the group replaces it.
 */
export interface WatchPrediction {
  /** Whether this group, as the server last described it, has yet to show the action. */
  readonly awaits: (group: WatchGroup | null) => boolean;
  readonly apply: (group: WatchGroup | null) => WatchGroup | null;
}

type Position = Pick<WatchPlayback, "itemId" | "title" | "positionSeconds">;

const MAX_MEMBERS = 32;

/**
 * The server answers a playback action with the group's next revision, so the prediction holds
 * for exactly as long as the group stays at the revision it was made against.
 */
const nextRevision = (
  base: WatchGroup,
  playback: WatchPlayback | null,
): WatchPrediction => ({
  awaits: (group) => group?.id === base.id && group.revision === base.revision,
  apply: (group) => (group === null ? null : { ...group, revision: base.revision + 1, playback }),
});

const playbackPrediction = (
  action: Extract<WatchAction, { type: "play" | "pause" | "seek" | "stop" }>,
  base: WatchGroup,
  viewer: WatchViewer,
  nowMs: number,
): WatchPrediction | null => {
  const playback = base.playback;
  // Only the server knows the title of something the group is not already watching.
  if (playback === null || playback.itemId !== action.itemId) return null;
  if (action.type === "stop") return nextRevision(base, null);
  const position: Position = {
    itemId: playback.itemId,
    title: playback.title,
    positionSeconds: action.positionSeconds,
  };
  const held = playback.waitingFor !== undefined;
  const plays =
    action.type === "play" || (action.type === "pause" ? !action.paused : held || !playback.paused);
  if (!plays) return nextRevision(base, { ...position, paused: true, updatedAtMs: nowMs });
  // Asking a group that is about to play to play changes nothing.
  if (action.type === "pause" && held) return null;
  // The group holds for this viewer's player at least; who else it waits for is the server's
  // to say, and nobody is named until it does.
  return nextRevision(base, {
    ...position,
    paused: viewer.readiness,
    updatedAtMs: nowMs,
    ...(viewer.readiness ? { waitingFor: [] } : {}),
  });
};

/**
 * Predicts what an action will do to the viewer's group, or returns null when only the server
 * can tell: whether a password is right, what an item is called, or what a busy group became.
 */
export const predictWatchAction = (
  action: WatchAction,
  status: Pick<WatchStatus, "group" | "groups">,
  viewer: WatchViewer,
  nowMs: number,
): WatchPrediction | null => {
  const current = status.group;
  if (action.type === "leave")
    return current === null ? null : { awaits: (group) => group !== null, apply: () => null };
  if (action.type === "create" || action.type === "join") {
    if (viewer.displayName === null) return null;
    const member = { id: viewer.memberId, displayName: viewer.displayName };
    if (action.type === "create") {
      const created: WatchGroup = {
        id: randomId(),
        name: action.name.trim(),
        hasPassword: action.password !== "",
        members: [member],
        playback: null,
        revision: 0,
      };
      // The server names the new group itself; any other group it reports is that one.
      return {
        awaits: (group) => group === null || group.id === current?.id,
        apply: () => created,
      };
    }
    const listed = status.groups.find((group) => group.id === action.groupId);
    if (
      listed === undefined ||
      listed.hasPassword ||
      listed.id === current?.id ||
      listed.members.length >= MAX_MEMBERS
    )
      return null;
    const joined = { ...listed, members: [...listed.members, member] };
    return { awaits: (group) => group?.id !== listed.id, apply: () => joined };
  }
  if (action.type === "play" || action.type === "pause" || action.type === "seek" || action.type === "stop")
    return current === null ? null : playbackPrediction(action, current, viewer, nowMs);
  return null;
};
