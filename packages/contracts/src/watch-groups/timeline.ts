import type { GroupPlayback, GroupSnapshot } from "../schemas/watch-groups.ts";
export const positionAt = (state: GroupPlayback, serverNowMs: number): number => {
  if (state.media === null) return 0;
  const elapsed =
    state.mode === "playing" ? Math.max(0, serverNowMs - state.anchorServerTimeMs) : 0;
  return Math.min(
    state.media.durationMs ?? Infinity,
    Math.max(0, state.anchorPositionMs + elapsed),
  );
};
export const playbackRevision = (snapshot: GroupSnapshot): number =>
  snapshot.playback.type === "playback"
    ? snapshot.playback.state.revision
    : snapshot.playback.revision;
export const snapshotPlaybackId = (snapshot: GroupSnapshot): string =>
  snapshot.playback.type === "playback"
    ? snapshot.playback.state.playbackId
    : snapshot.playback.playbackId;
