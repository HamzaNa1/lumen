import type { Dimensions, PlaybackInfo, PlayableStream } from "@lumen/contracts";

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });

const audioCodecs: Readonly<Record<string, string>> = {
  aac: "AAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
};

const languageName = (code: string | null): string | null => {
  if (code === null || code === "" || code === "und") return null;
  try {
    const name = languageNames.of(code);
    return name === undefined || name === code ? code.toUpperCase() : name;
  } catch {
    return code.toUpperCase();
  }
};

const audioCodec = (codec: string | null): string | null => {
  if (codec === null || codec === "") return null;
  if (codec.startsWith("pcm_")) return "PCM";
  return audioCodecs[codec] ?? codec.toUpperCase();
};

const channelLayout = (channels: number): string =>
  channels === 1 ? "Mono" : channels === 2 ? "Stereo" : `${channels} channels`;

const baseLabel = (stream: PlayableStream, index: number): string => {
  const parts: string[] = [];
  for (const part of [
    languageName(stream.language),
    stream.title,
    stream.commentary === true ? "Commentary" : null,
    stream.forced === true ? "Forced" : null,
    stream.hearingImpaired === true ? "Hearing impaired" : null,
    stream.kind === "audio" ? audioCodec(stream.codec) : null,
    stream.kind === "audio" && stream.channels != null ? channelLayout(stream.channels) : null,
  ]) {
    if (part === null || part === "") continue;
    if (!parts.some((existing) => existing.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  return parts.length === 0 ? `Track ${index + 1}` : parts.join(" · ");
};

/** Viewer-facing names for a list of audio or subtitle streams, e.g. "English · Commentary · AAC". */
export const streamLabels = (streams: ReadonlyArray<PlayableStream>): string[] => {
  const labels = streams.map(baseLabel);
  return labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label) || label.startsWith("Track ")
      ? label
      : `${label} · Track ${index + 1}`,
  );
};

/** Why some tracks cannot be switched in this player, whatever the file contains. */
export const trackSelectionWarning = (
  trackSelection: boolean,
  subtitleSelection: boolean,
): string | null =>
  !trackSelection
    ? "This browser can’t switch audio tracks or select embedded subtitles."
    : !subtitleSelection
      ? "This browser can’t select embedded subtitles."
      : null;

export const formatPlayerTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const secondsPart = String(value % 60).padStart(2, "0");
  return value >= 3_600
    ? `${Math.floor(value / 3_600)}:${String(minutes % 60).padStart(2, "0")}:${secondsPart}`
    : `${minutes}:${secondsPart}`;
};

const clockTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The wall-clock time playback would finish if it ran uninterrupted from now, e.g. "Ends at 9:56 PM". */
export const formatEndsAt = (remainingSeconds: number, nowMs: number): string =>
  `Ends at ${clockTimeFormatter.format(nowMs + Math.max(0, remainingSeconds) * 1_000)}`;

const decimalUnits = (value: number, units: ReadonlyArray<string>): string => {
  let scaled = value;
  let unit = 0;
  while (scaled >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  // Three significant figures, such as "1.50 GB" or "640 kbps".
  return `${unit === 0 || scaled >= 1_000 ? Math.round(scaled) : scaled.toPrecision(3)} ${units[unit]}`;
};

const formatSize = (size: Dimensions | null): string | null =>
  size === null ? null : `${size.width}×${size.height}`;

const formatBitrate = (bitsPerSecond: number | null | undefined): string | null =>
  bitsPerSecond == null ? null : decimalUnits(bitsPerSecond, ["bps", "kbps", "Mbps", "Gbps"]);

export interface PlaybackInfoSection {
  readonly title: string;
  readonly rows: ReadonlyArray<readonly [label: string, value: string]>;
}

const section = (
  title: string,
  rows: ReadonlyArray<readonly [string, string | number | null | undefined]>,
): PlaybackInfoSection => ({
  title,
  rows: rows.flatMap(([label, value]) =>
    value === null || value === undefined || value === "" ? [] : [[label, String(value)] as const],
  ),
});

/** What a player reported, grouped and named the way Jellyfin's playback info shows it. */
export const playbackInfoSections = (info: PlaybackInfo): ReadonlyArray<PlaybackInfoSection> => {
  const { media, audio } = info;
  const sizeBytes = media?.sizeBytes ?? null;
  return [
    section("Playback info", [
      ["Player", info.player],
      // Lumen plays the file as it is stored; the server never transcodes it.
      ["Play method", "Direct playing"],
      ["Protocol", info.protocol],
      ["Stream type", info.videoSize !== null || media?.video != null ? "Video" : "Audio"],
    ]),
    section("Video info", [
      ["Player dimensions", formatSize(info.playerSize)],
      ["Video resolution", formatSize(info.videoSize)],
      ["Dropped frames", info.droppedFrames],
      ["Corrupted frames", info.corruptedFrames],
    ]),
    section("Original media info", [
      ["Container", media?.container],
      ["Size", sizeBytes === null ? null : decimalUnits(sizeBytes, ["B", "kB", "MB", "GB", "TB"])],
      [
        "Bitrate",
        sizeBytes === null || info.durationSeconds === null || info.durationSeconds <= 0
          ? null
          : formatBitrate((sizeBytes * 8) / info.durationSeconds),
      ],
      ["Video codec", media?.video?.codec?.toUpperCase()],
      ["Video resolution", formatSize(media?.video?.size ?? null)],
      ["Video bitrate", formatBitrate(media?.video?.bitrate)],
      ["Audio codec", audio === null ? null : audioCodec(audio.codec)],
      ["Audio bitrate", formatBitrate(audio?.bitrate)],
      ["Audio channels", audio?.channels == null ? null : channelLayout(audio.channels)],
      ["Audio sample rate", audio?.sampleRateHz == null ? null : `${audio.sampleRateHz} Hz`],
    ]),
  ].filter((candidate) => candidate.rows.length > 0);
};
