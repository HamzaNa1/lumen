import type { PlaybackStartResponse } from "../services/PlaybackService";
export const playbackResponse = (result: PlaybackStartResponse) => ({
  sessionId: result.session.id,
  itemId: result.itemId,
  sourceId: result.sourceId,
  sourceGeneration: result.sourceGeneration,
  title: result.title,
  streamUrl: result.streamPath,
  durationSeconds: result.durationSeconds,
  streams: result.streams,
  grantExpiresInSeconds: result.grantExpiresInSeconds,
  grantToken: result.grantToken,
  mode: "DirectPlay",
});
