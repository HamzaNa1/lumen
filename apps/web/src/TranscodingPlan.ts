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
  const container = session.media.container;
  const mime =
    container === "webm"
      ? "video/webm"
      : container === "ogg" || container === "oga"
        ? "audio/ogg"
        : container === "flac"
          ? "audio/flac"
          : container === "wav"
            ? "audio/wav"
            : container === "mp3"
              ? "audio/mpeg"
              : ["mp4", "m4v", "m4a", "mov"].includes(container ?? "")
                ? "video/mp4"
                : null;
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
  const nativeAudio =
    session.media.video === null &&
    ((container === "wav" && audio?.startsWith("pcm_")) ||
      (container === "flac" && audio === "flac") ||
      (container === "mp3" && audio === "mp3"));
  if (
    mime &&
    canPlay(mime) !== "" &&
    supported(video, videoCodecs, mime) &&
    (nativeAudio || supported(audio, audioCodecs, mime)) &&
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

export const audioCodecProbe = (codec: string | null): string | null => {
  const value = audioCodecs[codec?.toLowerCase() ?? ""];
  return value === undefined ? null : `audio/mp4; codecs="${value}"`;
};
