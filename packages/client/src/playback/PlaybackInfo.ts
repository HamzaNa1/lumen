import type { Dimensions, PlaybackInfo, PlayerSession } from "@lumen/contracts";

/** What only the player itself can measure about the playback in progress. */
export type PlayerMeasurements = Pick<
  PlaybackInfo,
  "player" | "playerSize" | "videoSize" | "droppedFrames" | "corruptedFrames"
>;

/** A measured size, or null while there is nothing to measure. */
export const measuredSize = (width: unknown, height: unknown): Dimensions | null =>
  typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;

/** A player's own measurements, alongside what the server said about the file it is playing. */
export const describePlayback = (
  session: PlayerSession,
  serverOrigin: string,
  selectedAudioStreamId: string | null,
  measured: PlayerMeasurements,
): PlaybackInfo => {
  const audioStreams = session.streams.filter((stream) => stream.kind === "audio");
  return {
    ...measured,
    protocol: new URL(session.streamUrl, serverOrigin).protocol.replace(/:$/, ""),
    durationSeconds: session.durationSeconds,
    media: session.media ?? null,
    // A player that cannot switch tracks plays whichever one the file marks as the default.
    audio:
      audioStreams.find((stream) => stream.id === selectedAudioStreamId) ??
      audioStreams.find((stream) => stream.isDefault) ??
      audioStreams[0] ??
      null,
  };
};
