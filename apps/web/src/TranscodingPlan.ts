import type { TranscodingPlan } from "@lumen/client";

export type { TranscodingPlan } from "@lumen/client";

import type { PlayerSession } from "@lumen/contracts";
import { resolveTrackSelection } from "@lumen/contracts";

const videoCodecs: Readonly<Record<string, string>> = {
  h264: "avc1.640028",
  hevc: "hvc1.1.6.L120.B0",
  vp8: "vp8",
  vp9: "vp09.00.10.08",
  av1: "av01.0.08M.08",
};
const audioCodecs: Readonly<Record<string, string>> = {
  aac: "mp4a.40.2",
  mp3: "mp3",
  opus: "opus",
  vorbis: "vorbis",
  flac: "flac",
  ac3: "ac-3",
  eac3: "ec-3",
  dts: "dtsc",
  truehd: "mlpa",
};

const selectedAudio = (session: PlayerSession) => {
  const streams = session.streams
    .filter((stream) => stream.kind === "audio")
    .sort((a, b) => a.ordinal - b.ordinal);
  const selected =
    resolveTrackSelection(streams, session.sourceId, session.trackMemory).audio ??
    streams.find((stream) => stream.isDefault) ??
    streams[0];
  return {
    streams,
    selected,
    index: Math.max(
      0,
      streams.findIndex((stream) => stream.id === selected?.id),
    ),
  };
};

const outputFormat = (canPlay: (mime: string) => string): "mp4" | "webm" => {
  if (canPlay('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "") return "mp4";
  if (canPlay('video/webm; codecs="vp8, opus"') !== "") return "webm";
  throw new Error(
    "This browser cannot decode either available transcoding format (H.264/AAC or VP8/Opus).",
  );
};

export const transcodingPlan = (
  session: PlayerSession,
  canPlay: (mime: string) => string,
  canSelectAudio = false,
): TranscodingPlan | null => {
  if (!session.media) return null;
  const mime = session.media.mimeType;
  if (!mime) return null;
  const video = session.media.video?.codec;
  const { streams: audios, selected, index } = selectedAudio(session);
  const audio = selected?.codec;
  const supported = (
    codec: string | null | undefined,
    mapping: Readonly<Record<string, string>>,
    type: string,
  ) =>
    codec === undefined || codec === null
      ? codec === undefined
      : mapping[codec] !== undefined && canPlay(`${type}; codecs="${mapping[codec]}"`) !== "";
  const audioProbe = audioCodecProbe(audio ?? null, mime);
  if (
    mime &&
    canPlay(mime) !== "" &&
    supported(video, videoCodecs, mime) &&
    (audio === undefined || (audioProbe !== null && canPlay(audioProbe) !== "")) &&
    (canSelectAudio || selected === (audios.find((stream) => stream.isDefault) ?? audios[0]))
  )
    return null;
  const mp4 = outputFormat(canPlay) === "mp4";
  return {
    format: mp4 ? "mp4" : "webm",
    audioIndex: index,
    video:
      session.media.video === null
        ? "none"
        : !mp4
          ? "vp8"
          : video === "h264" && supported(video, videoCodecs, "video/mp4")
            ? "copy"
            : "h264",
    audio: !mp4
      ? "opus"
      : audios.length === 0 || (audio === "aac" && supported(audio, audioCodecs, "audio/mp4"))
        ? "copy"
        : "aac",
  };
};

export const fallbackTranscodingPlan = (
  session: PlayerSession,
  canPlay: (mime: string) => string,
): TranscodingPlan => {
  const mp4 = outputFormat(canPlay) === "mp4";
  return {
    format: mp4 ? "mp4" : "webm",
    video: session.media?.video === null ? "none" : mp4 ? "h264" : "vp8",
    audio: mp4 ? "aac" : "opus",
    audioIndex: selectedAudio(session).index,
  };
};

export const audioCodecProbe = (codec: string | null, mime = "audio/mp4"): string | null => {
  const name = codec?.toLowerCase() ?? "";
  if (
    (mime === "audio/aac" && name === "aac") ||
    (mime === "audio/mpeg" && name === "mp3") ||
    (mime === "audio/flac" && name === "flac") ||
    (mime === "audio/wav" && name.startsWith("pcm_"))
  )
    return mime;
  const value = audioCodecs[name];
  return value === undefined ? null : `${mime}; codecs="${value}"`;
};
