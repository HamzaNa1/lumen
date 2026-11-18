import type { Dimensions, PlaybackInfo, PlayerSession } from "@lumen/contracts";

/** What a player reports; the watch group's part is added by whoever drives the group. */
export type PlayerPlaybackInfo = Omit<PlaybackInfo, "sync">;

/** What only the player itself can measure about the playback in progress. */
export type PlayerMeasurements = Omit<
  PlayerPlaybackInfo,
  "sessionId" | "protocol" | "durationSeconds" | "media" | "audio" | "subtitle"
>;

/** A measured size, or null while there is nothing to measure. */
export const measuredSize = (width: unknown, height: unknown): Dimensions | null =>
  typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;

/** A measured rate, or null where the player has none to give. */
export const measuredRate = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** A player's own measurements, alongside what the server said about the file it is playing. */
export const describePlayback = (
  session: PlayerSession,
  serverOrigin: string,
  selected: { readonly audio: string | null; readonly subtitle: string | null },
  measured: PlayerMeasurements,
): PlayerPlaybackInfo => {
  const audioStreams = session.streams.filter((stream) => stream.kind === "audio");
  const serverProtocol = new URL(session.streamUrl, serverOrigin).protocol.replace(/:$/, "");
  const { delivery } = measured;
  return {
    ...measured,
    sessionId: session.sessionId,
    protocol:
      delivery.kind === "original" && delivery.fromDevice
        ? null
        : delivery.kind === "adaptive"
          ? `HLS over ${serverProtocol}`
          : serverProtocol,
    durationSeconds: session.durationSeconds,
    media: session.media ?? null,
    // A player that cannot switch tracks plays whichever one the file marks as the default.
    audio:
      audioStreams.find((stream) => stream.id === selected.audio) ??
      audioStreams.find((stream) => stream.isDefault) ??
      audioStreams[0] ??
      null,
    subtitle:
      session.streams.find(
        (stream) => stream.kind === "subtitle" && stream.id === selected.subtitle,
      ) ?? null,
  };
};
