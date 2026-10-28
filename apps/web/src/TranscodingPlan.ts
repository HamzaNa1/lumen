import type { PlayerSession } from "@lumen/contracts";

export interface TranscodingPlan {
  readonly audioIndex: number;
  readonly video: "copy" | "h264";
  readonly audio: "copy" | "aac";
}

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

export const transcodingPlan = (
  session: PlayerSession,
  canPlay: (mime: string) => string,
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
  const audios = session.streams.filter((stream) => stream.kind === "audio");
  const audio = (audios.find((stream) => stream.isDefault) ?? audios[0])?.codec;
  const supported = (
    codec: string | null | undefined,
    mapping: Readonly<Record<string, string>>,
    type: string,
  ) =>
    codec === undefined || codec === null
      ? codec === undefined
      : mapping[codec] !== undefined && canPlay(`${type}; codecs="${mapping[codec]}"`) !== "";
  if (
    mime &&
    canPlay(mime) !== "" &&
    supported(video, videoCodecs, mime) &&
    supported(audio, audioCodecs, mime)
  )
    return null;
  return {
    audioIndex: Math.max(
      0,
      audios.findIndex((stream) => stream.isDefault),
    ),
    video:
      session.media.video === null ||
      (video === "h264" && supported(video, videoCodecs, "video/mp4"))
        ? "copy"
        : "h264",
    audio:
      audios.length === 0 || (audio === "aac" && supported(audio, audioCodecs, "audio/mp4"))
        ? "copy"
        : "aac",
  };
};
