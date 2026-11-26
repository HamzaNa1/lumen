import type { VideoDetails } from "./Probe";
import type { DeviceProfile, ProfileCondition, SubtitleDelivery } from "./Schemas";

export interface DecisionInput {
  readonly container: string | null;
  /** The whole file, in bits per second. */
  readonly bitrate: number | null;
  readonly video: {
    readonly codec: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly bitrate: number | null;
    /** What a probe of the file found; absent or null when it has not been probed. */
    readonly details?: VideoDetails | null;
  } | null;
  /** The audio stream that will play. */
  readonly audio: {
    readonly codec: string | null;
    readonly channels: number | null;
    readonly bitrate: number | null;
  } | null;
  readonly subtitles: ReadonlyArray<{ readonly index: number; readonly codec: string | null }>;
  readonly profile: DeviceProfile | null;
  readonly maxStreamingBitrate: number | null;
  readonly enableDirectPlay: boolean;
  readonly enableTranscoding: boolean;
  /** The server may encode H.264 for adaptive streams. */
  readonly canConvert: boolean;
}

export type SubtitleFormat = "vtt" | "srt" | "ass";

export interface SubtitlePlan {
  readonly method: SubtitleDelivery;
  readonly format?: SubtitleFormat;
}

export type Decision =
  | { readonly kind: "DirectPlay"; readonly subtitles: ReadonlyMap<number, SubtitlePlan> }
  | {
      readonly kind: "Transcode";
      readonly ceilingKbps: number | null;
      readonly subtitles: ReadonlyMap<number, SubtitlePlan>;
    }
  | { readonly kind: "NoCompatibleStream" };

const ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ["mkv", "matroska", "webm"],
  ["mp4", "m4v", "mov"],
  ["hevc", "h265"],
  ["dts", "dca"],
  ["srt", "subrip"],
  ["vtt", "webvtt"],
  ["ass", "ssa"],
  ["pgssub", "hdmv_pgs_subtitle"],
  ["dvdsub", "dvd_subtitle"],
];

const names = (value: string | null | undefined): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const entry of (value ?? "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (name === "") continue;
    result.add(name);
    for (const group of ALIASES)
      if (group.includes(name)) for (const alias of group) result.add(alias);
  }
  return result;
};

/** An empty list allows anything; an unknown value matches only an empty list. */
const allows = (list: string | null | undefined, value: string | null): boolean => {
  const allowed = names(list);
  return allowed.size === 0 || (value !== null && allowed.has(value.toLowerCase()));
};

const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
export const isTextSubtitle = (codec: string | null): boolean => TEXT_CODECS.has(codec ?? "");

/**
 * What Lumen reports for video it has not probed. Conditions are judged against the same values
 * the app is told, so a profile never rejects what it was shown.
 */
export const VIDEO_RANGE = "SDR";

const conditionValue = (
  property: string | null | undefined,
  input: DecisionInput,
): number | string | boolean | null | undefined => {
  switch (property) {
    case "VideoRangeType":
      return input.video === null ? null : (input.video.details?.rangeType ?? VIDEO_RANGE);
    case "IsInterlaced":
      return input.video === null ? null : (input.video.details?.interlaced ?? false);
    case "VideoProfile":
      return input.video?.details?.profile ?? null;
    case "VideoLevel":
      return input.video?.details?.level ?? null;
    case "VideoBitDepth":
      return input.video?.details?.bitDepth ?? null;
    case "IsAnamorphic":
      return input.video?.details?.anamorphic ?? null;
    case "RefFrames":
      return input.video?.details?.refFrames ?? null;
    case "VideoCodecTag":
      return input.video?.details?.codecTag ?? null;
    case "VideoFramerate":
      return input.video?.details?.frameRate ?? null;
    case "Width":
      return input.video?.width ?? null;
    case "Height":
      return input.video?.height ?? null;
    case "VideoBitrate":
      return input.video?.bitrate ?? null;
    case "AudioChannels":
      return input.audio?.channels ?? null;
    case "AudioBitrate":
      return input.audio?.bitrate ?? null;
    default:
      return undefined;
  }
};

/** Jellyfin lets a condition on a value it does not know pass, unless the condition requires it. */
const satisfies = (condition: ProfileCondition, input: DecisionInput): boolean => {
  const actual = conditionValue(condition.Property, input);
  if (actual === undefined || actual === null) return condition.IsRequired !== true;
  const expected = (condition.Value ?? "").split("|").map((value) => value.trim().toLowerCase());
  const first = expected[0] ?? "";
  const same = (value: string) =>
    typeof actual === "number" ? Number(value) === actual : value === String(actual).toLowerCase();
  const limit = Number(first);
  switch (condition.Condition) {
    case "Equals":
      return same(first);
    case "NotEquals":
      return !same(first);
    case "LessThanEqual":
      return typeof actual !== "number" || Number.isNaN(limit) || actual <= limit;
    case "GreaterThanEqual":
      return typeof actual !== "number" || Number.isNaN(limit) || actual >= limit;
    case "EqualsAny":
      return expected.some(same);
    default:
      return true;
  }
};

const codecProfilesPass = (profile: DeviceProfile, input: DecisionInput): boolean =>
  (profile.CodecProfiles ?? []).every((codecProfile) => {
    const type = codecProfile.Type ?? "Video";
    const codec = type === "Video" ? input.video?.codec : input.audio?.codec;
    if (type !== "Video" && type !== "VideoAudio") return true;
    if (!allows(codecProfile.Codec, codec ?? null)) return true;
    if (!allows(codecProfile.Container, input.container)) return true;
    if (!(codecProfile.ApplyConditions ?? []).every((condition) => satisfies(condition, input)))
      return true;
    return (codecProfile.Conditions ?? []).every((condition) => satisfies(condition, input));
  });

const directPlayable = (profile: DeviceProfile | null, input: DecisionInput): boolean => {
  if (profile === null || profile.DirectPlayProfiles == null) return true;
  return (
    profile.DirectPlayProfiles.some(
      (entry) =>
        (entry.Type ?? "Video") === "Video" &&
        allows(entry.Container, input.container) &&
        allows(entry.VideoCodec, input.video?.codec ?? null) &&
        (input.audio === null || allows(entry.AudioCodec, input.audio.codec)),
    ) && codecProfilesPass(profile, input)
  );
};

const offered = (profile: DeviceProfile | null, method: SubtitleDelivery) =>
  (profile?.SubtitleProfiles ?? []).filter((entry) => entry.Method === method);

const externalFormat = (profile: DeviceProfile | null, codec: string | null): SubtitleFormat => {
  const formats = names(
    offered(profile, "External")
      .map((entry) => entry.Format ?? "")
      .join(","),
  );
  const candidates: ReadonlyArray<SubtitleFormat> =
    codec === "ass" || codec === "ssa" ? ["ass", "vtt", "srt"] : ["vtt", "srt"];
  return candidates.find((format) => formats.has(format)) ?? "vtt";
};

const subtitlePlans = (
  input: DecisionInput,
  converting: boolean,
): ReadonlyMap<number, SubtitlePlan> => {
  const { profile } = input;
  const embedded = offered(profile, "Embed");
  const external = offered(profile, "External");
  return new Map(
    input.subtitles.map((stream): [number, SubtitlePlan] => {
      const text = isTextSubtitle(stream.codec);
      if (converting)
        return [
          stream.index,
          text
            ? { method: "External", format: externalFormat(profile, stream.codec) }
            : { method: "Drop" },
        ];
      const embeds =
        profile === null ||
        embedded.some((entry) => allows(entry.Format, stream.codec)) ||
        (text && external.length === 0);
      if (!embeds && text)
        return [
          stream.index,
          { method: "External", format: externalFormat(profile, stream.codec) },
        ];
      return [stream.index, { method: "Embed" }];
    }),
  );
};

export const decidePlayback = (input: DecisionInput): Decision => {
  // The request's cap and the profile's both hold; the stricter one wins.
  const caps = [input.maxStreamingBitrate, input.profile?.MaxStreamingBitrate].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  const cap = caps.length === 0 ? null : Math.min(...caps);
  const fits = cap === null || input.bitrate === null || input.bitrate <= cap;
  if (input.enableDirectPlay && fits && directPlayable(input.profile, input))
    return { kind: "DirectPlay", subtitles: subtitlePlans(input, false) };
  if (input.enableTranscoding && input.canConvert && input.video !== null)
    return {
      kind: "Transcode",
      ceilingKbps: cap === null ? null : Math.max(1, Math.floor(cap / 1000)),
      subtitles: subtitlePlans(input, true),
    };
  return { kind: "NoCompatibleStream" };
};
