import { positionAt, type GroupMedia, type GroupPlayback } from "@lumen/contracts";
export type PreparedAction =
  | {
      readonly type: "start";
      readonly media: GroupMedia;
      readonly positionMs: number;
      readonly playbackId: string;
    }
  | { readonly type: "set-paused"; readonly paused: boolean }
  | { readonly type: "seek"; readonly positionMs: number }
  | { readonly type: "stop"; readonly playbackId: string }
  | {
      readonly type: "end";
      readonly expectedRevision: number;
      readonly expectedPlaybackId: string;
    };
export const initialPlayback = (
  serverInstanceId: string,
  groupId: string,
  playbackId: string,
  now: number,
): GroupPlayback => ({
  serverInstanceId,
  groupId,
  playbackId,
  revision: 0,
  alignmentRevision: 0,
  mode: "stopped",
  media: null,
  anchorPositionMs: 0,
  anchorServerTimeMs: now,
});
export const transition = (
  state: GroupPlayback,
  action: PreparedAction,
  now: number,
): GroupPlayback => {
  if (
    action.type === "end" &&
    (state.revision !== action.expectedRevision ||
      state.playbackId !== action.expectedPlaybackId ||
      state.mode !== "playing" ||
      state.media?.durationMs == null ||
      positionAt(state, now) < state.media.durationMs)
  )
    return state;
  const revision = state.revision + 1;
  const next = {
    ...state,
    revision,
    anchorServerTimeMs: now,
    anchorPositionMs: positionAt(state, now),
  };
  switch (action.type) {
    case "start":
      requirePosition(action.positionMs, action.media);
      return {
        ...next,
        media: action.media,
        playbackId: action.playbackId,
        mode: "playing",
        anchorPositionMs: action.positionMs,
        alignmentRevision: revision,
      };
    case "stop":
      return {
        ...next,
        media: null,
        mode: "stopped",
        playbackId: action.playbackId,
        anchorPositionMs: 0,
      };
    case "set-paused":
      if (state.media === null || (state.mode === "ended" && !action.paused))
        throw new Error("Playback cannot resume without a start or backward seek");
      return {
        ...next,
        mode: state.mode === "ended" ? "ended" : action.paused ? "paused" : "playing",
      };
    case "seek":
      if (state.media === null) throw new Error("No active media");
      requirePosition(action.positionMs, state.media);
      return {
        ...next,
        anchorPositionMs: action.positionMs,
        alignmentRevision: revision,
        mode:
          state.mode === "ended" &&
          (state.media.durationMs === null || action.positionMs < state.media.durationMs)
            ? "paused"
            : state.mode,
      };
    case "end":
      return {
        ...next,
        mode: "ended",
        anchorPositionMs: state.media?.durationMs ?? next.anchorPositionMs,
      };
  }
};
const requirePosition = (position: number, media: GroupMedia): void => {
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    (media.durationMs !== null && position > media.durationMs)
  )
    throw new Error("Position is outside the media duration");
};
