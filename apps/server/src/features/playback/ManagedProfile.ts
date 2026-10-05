import type { FfprobeResult } from "../../media/Ffprobe";

export class ManagedPreparationError extends Error {}

export const MANAGED_PROFILE = "h264-aac-fmp4-v1";
export const MAX_SEGMENT_SECONDS = 15;
export const MAX_SEGMENT_BYTES = 16 * 1024 ** 2;
export const ENCODED_WINDOW_BYTES = 64 * 1024 ** 2;
export const MAX_PACKAGE_SEGMENTS = 21_600;

export interface ManagedSource {
  readonly sessionId: string;
  readonly trackId: string;
  readonly sourceId: string;
  readonly absolutePath: string;
  readonly rootPath: string;
  readonly video: { readonly id: string; readonly ordinal: number };
  readonly audio: { readonly id: string; readonly ordinal: number } | null;
}

export const assertManagedProfile = (source: ManagedSource, probe: FfprobeResult): void => {
  if (
    !/\.(mp4|mkv)$/iu.test(source.absolutePath) ||
    !probe.container
      ?.split(",")
      .some((container) => container === "mov" || container === "matroska")
  )
    throw new ManagedPreparationError("Managed playback supports MP4 and Matroska video only");
  if (
    probe.durationMs === null ||
    probe.durationMs <= 0 ||
    probe.startSeconds == null ||
    Math.abs(probe.startSeconds) > 0.25
  )
    throw new ManagedPreparationError("The source timeline is not supported by managed playback");
  const video = probe.streams.find((stream) => stream.ordinal === source.video.ordinal);
  if (
    video?.kind !== "video" ||
    video.codec !== "h264" ||
    video.pixelFormat !== "yuv420p" ||
    !["Baseline", "Constrained Baseline", "Main", "High"].includes(video.profile ?? "") ||
    video.level == null ||
    video.level <= 0 ||
    video.level > 52
  )
    throw new ManagedPreparationError(
      "Managed playback requires H.264 8-bit 4:2:0 video with a verified profile",
    );
  const audio =
    source.audio === null
      ? null
      : probe.streams.find((stream) => stream.ordinal === source.audio?.ordinal);
  const intended = probe.streams.filter((stream) => stream.kind === "audio");
  const defaultAudio = intended.find((stream) => stream.isDefault) ?? intended[0];
  if ((defaultAudio?.ordinal ?? null) !== (source.audio?.ordinal ?? null))
    throw new ManagedPreparationError("The intended audio stream could not be verified");
  if (
    source.audio !== null &&
    (audio?.kind !== "audio" || audio.codec !== "aac" || audio.profile !== "LC")
  )
    throw new ManagedPreparationError("Managed playback requires the intended AAC-LC audio stream");
  for (const stream of [video, audio]) {
    if (stream !== null && (stream?.startSeconds == null || Math.abs(stream.startSeconds) > 0.25))
      throw new ManagedPreparationError("The selected streams have an unsupported timeline");
  }
};

/** Reads AVC's exact profile/constraint/level bytes from the muxed sample description. */
export const managedAvcConfiguration = (
  init: Uint8Array,
): { readonly codec: string; readonly nalLengthSize: number } => {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const find = (start: number, end: number): { codec: string; nalLengthSize: number } | null => {
    for (let offset = start; offset + 8 <= end; ) {
      const size = view.getUint32(offset);
      const kind = String.fromCharCode(...init.subarray(offset + 4, offset + 8));
      if (size < 8 || offset + size > end)
        throw new ManagedPreparationError("Invalid initialization segment");
      if (kind === "avcC") {
        if (size < 13 || init[offset + 8] !== 1)
          throw new ManagedPreparationError("Invalid AVC configuration");
        return {
          codec: `avc1.${[...init.subarray(offset + 9, offset + 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
          nalLengthSize: ((init[offset + 12] ?? 0) & 3) + 1,
        };
      }
      const skip = ["moov", "trak", "mdia", "minf", "stbl"].includes(kind)
        ? 8
        : kind === "stsd"
          ? 16
          : kind === "avc1"
            ? 86
            : null;
      if (skip !== null) {
        const codec = find(offset + skip, offset + size);
        if (codec !== null) return codec;
      }
      offset += size;
    }
    return null;
  };
  const video = find(0, init.length);
  if (video === null)
    throw new ManagedPreparationError("The output AVC configuration could not be verified");
  return video;
};

export const managedMimeType = (init: Uint8Array, audio: boolean): string =>
  `video/mp4; codecs="${managedAvcConfiguration(init).codec}${audio ? ",mp4a.40.2" : ""}"`;

export interface ManagedSegment {
  readonly name: string;
  readonly duration: number;
  readonly size: number;
}

/** Includes segment alignment at both edges and a complete in-flight segment. */
export const managedBufferPolicy = (segments: readonly ManagedSegment[]) => {
  const maxDuration = Math.max(...segments.map((segment) => segment.duration));
  const maxSize = Math.max(...segments.map((segment) => segment.size));
  const bytesPerSecond = Math.max(...segments.map((segment) => segment.size / segment.duration));
  let forward = 30;
  let back = 15;
  const estimate = () => Math.ceil((forward + back + 2 * maxDuration) * bytesPerSecond + maxSize);
  while (estimate() > ENCODED_WINDOW_BYTES && (back > 0 || forward > 5)) {
    if (back > 0) back -= 1;
    else forward -= 1;
  }
  if (estimate() > ENCODED_WINDOW_BYTES)
    throw new ManagedPreparationError(
      "The package cannot hold the watch-group readiness window within the encoded-data budget",
    );
  return { forwardBufferSeconds: forward, backBufferSeconds: back, encodedWindowBytes: estimate() };
};
