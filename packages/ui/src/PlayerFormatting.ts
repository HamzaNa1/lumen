import type {
  Dimensions,
  PlayableStream,
  PlaybackDelivery,
  PlaybackInfo,
  PlayerQuality,
  QualityOption,
  WatchSyncInfo,
} from "@lumen/contracts";

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

const clockTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

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

/** A size in bytes, such as "1.50 GB". */
export const formatBytes = (bytes: number): string =>
  decimalUnits(bytes, ["B", "kB", "MB", "GB", "TB"]);

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

const subtitleCodecs: Readonly<Record<string, string>> = {
  subrip: "SRT",
  srt: "SRT",
  ass: "ASS",
  ssa: "SSA",
  webvtt: "WebVTT",
  mov_text: "MP4 text",
  hdmv_pgs_subtitle: "PGS",
  dvd_subtitle: "VobSub",
  dvb_subtitle: "DVB",
};

const codecNames: Readonly<Record<string, string>> = {
  h264: "H.264",
  vp8: "VP8",
  aac: "AAC",
  opus: "Opus",
};

const deliveryLabel = (delivery: PlaybackDelivery): string => {
  if (delivery.kind === "original")
    return delivery.fromDevice ? "Direct play from this device" : "Direct play";
  if (delivery.kind === "adaptive") return `Converting (${delivery.rendition})`;
  const { video, audio } = delivery;
  if (video === "copy" && audio === "copy") return "Repackaging";
  if (video === "copy" || video === "none") return `Converting audio to ${codecNames[audio]}`;
  return `Converting to ${codecNames[video]} and ${audio === "copy" ? "original audio" : codecNames[audio]}`;
};

const qualityRows = (quality: PlayerQuality | null) => {
  if (quality === null) return [];
  const playing = quality.options.find((option) => option.id === quality.playing);
  return [
    ["Quality", qualityLabel(quality)],
    ["Quality bitrate", formatBitrate(playing?.kbps == null ? null : playing.kbps * 1_000)],
    [
      "Network speed",
      quality.measuredKbps === null ? "Measuring…" : formatBitrate(quality.measuredKbps * 1_000),
    ],
  ] as const;
};

const subtitleLabel = (info: PlaybackInfo): string => {
  const { subtitle } = info;
  if (subtitle !== null) {
    const codec =
      subtitle.codec === null
        ? null
        : (subtitleCodecs[subtitle.codec] ?? subtitle.codec.toUpperCase());
    const [label = "On"] = streamLabels([subtitle]);
    return codec === null ? label : `${label} · ${codec}`;
  }
  if (!info.subtitlesUnavailable) return "Off";
  return info.delivery.kind === "original"
    ? "Unavailable in this player"
    : "Unavailable while converting";
};

/** The parts that are known, on one line: "H264 · 1920×1080 · 8.00 Mbps". */
const joined = (parts: ReadonlyArray<string | null | undefined>): string | null => {
  const known = parts.filter((part): part is string => part != null && part !== "");
  return known.length === 0 ? null : known.join(" · ");
};

const formatRate = (value: number | null, unit: string): string | null =>
  value === null ? null : `${Number(value.toFixed(3))} ${unit}`;

const formatMs = (ms: number): string => `${Math.round(ms)} ms`;

const signedMs = (ms: number): string => {
  const rounded = Math.round(ms);
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
};

const dynamicRange = (transfer: string | null): string | null =>
  transfer === null ? null : transfer === "pq" ? "HDR10 (PQ)" : transfer === "hlg" ? "HLG" : "SDR";

const syncState = (sync: WatchSyncInfo): string => {
  if (sync.state === "idle") return "Nothing playing";
  if (sync.state === "playing") return "Playing";
  if (sync.state === "paused") return "Paused";
  const names = sync.waitingFor.map((name) => name ?? "you");
  return names.length === 0 ? "Holding" : `Holding for ${names.join(", ")}`;
};

const driftLabel = (seconds: number | null): string | null => {
  if (seconds === null) return null;
  const ms = Math.round(Math.abs(seconds) * 1_000);
  // Drift is the group's position less this player's: positive means this player is behind.
  return ms === 0 ? "0 ms" : `${ms} ms ${seconds > 0 ? "behind" : "ahead"}`;
};

const correctionLabel = (speed: number): string =>
  speed > 1
    ? `Catching up (${speed.toFixed(3)}×)`
    : speed < 1
      ? `Easing back (${speed.toFixed(3)}×)`
      : "In sync";

const syncConnection: Readonly<Record<WatchSyncInfo["connection"], string>> = {
  connected: "Connected",
  connecting: "Connecting",
  offline: "Reconnecting",
  unavailable: "Unavailable",
};

/** What a player reported, grouped and named the way Jellyfin's playback info shows it. */
export const playbackInfoSections = (
  info: PlaybackInfo,
  /** The app's version, for a viewer to quote alongside what the player reported. */
  appVersion?: string | null,
): ReadonlyArray<PlaybackInfoSection> => {
  const { media, audio, buffer, sync } = info;
  const sizeBytes = media?.sizeBytes ?? null;
  return [
    section("Playback info", [
      ["Player", info.player],
      ["Play method", deliveryLabel(info.delivery)],
      ["Protocol", info.protocol ?? "Local file"],
      ["Stream type", info.videoSize !== null || media?.video != null ? "Video" : "Audio"],
      ...qualityRows(info.quality),
      [
        "Buffered ahead",
        buffer === null
          ? null
          : buffer.toEnd
            ? "To the end"
            : `${buffer.aheadSeconds.toFixed(1)} s`,
      ],
      ["Subtitles", subtitleLabel(info)],
    ]),
    section("Video info", [
      ["Player dimensions", formatSize(info.playerSize)],
      ["Video resolution", formatSize(info.videoSize)],
      [
        "Decoder",
        info.decoding === null
          ? null
          : info.decoding.hardware === null
            ? "Software"
            : `Hardware (${info.decoding.hardware})`,
      ],
      ["Pixel format", info.pixelFormat],
      ["Colour", joined([info.colourPrimaries, info.colourTransfer])],
      ["Dynamic range", dynamicRange(info.colourTransfer)],
      ["Frame rate", formatRate(info.frameRate, "fps")],
      ["Output frame rate", formatRate(info.outputFrameRate, "fps")],
      ["Display refresh", formatRate(info.displayRefreshRate, "Hz")],
      ["A/V sync", info.avSyncSeconds === null ? null : signedMs(info.avSyncSeconds * 1_000)],
      ["Dropped frames", info.droppedFrames],
      ["Corrupted frames", info.corruptedFrames],
    ]),
    section("Original media info", [
      ["Container", media?.container],
      ["Size", sizeBytes === null ? null : formatBytes(sizeBytes)],
      [
        "Bitrate",
        sizeBytes === null || info.durationSeconds === null || info.durationSeconds <= 0
          ? null
          : formatBitrate((sizeBytes * 8) / info.durationSeconds),
      ],
      [
        "Video",
        joined([
          media?.video?.codec?.toUpperCase(),
          formatSize(media?.video?.size ?? null),
          formatBitrate(media?.video?.bitrate),
        ]),
      ],
      [
        "Audio",
        joined([
          audio === null ? null : audioCodec(audio.codec),
          audio?.channels == null ? null : channelLayout(audio.channels),
          audio?.sampleRateHz == null ? null : `${audio.sampleRateHz / 1_000} kHz`,
          formatBitrate(audio?.bitrate),
        ]),
      ],
    ]),
    ...(sync === null
      ? []
      : [
          section("Sync", [
            ["Connection", syncConnection[sync.connection]],
            ["Group", syncState(sync)],
            ["Drift", driftLabel(sync.driftSeconds)],
            ["Correction", correctionLabel(sync.speed)],
            ["Catch-up seeks", sync.catchUpSeeks],
            [
              "Round trip",
              sync.roundTripMs === null
                ? null
                : sync.bestRoundTripMs === null
                  ? formatMs(sync.roundTripMs)
                  : `${formatMs(sync.roundTripMs)} (best ${formatMs(sync.bestRoundTripMs)})`,
            ],
            ["Clock offset", sync.clockOffsetMs === null ? null : signedMs(sync.clockOffsetMs)],
          ]),
        ]),
    section("Session", [
      ["Session ID", info.sessionId],
      ["App", appVersion],
    ]),
  ].filter((candidate) => candidate.rows.length > 0);
};

/** The sections as plain text, for a viewer to paste into a bug report. */
export const playbackInfoText = (sections: ReadonlyArray<PlaybackInfoSection>): string =>
  sections
    .map((entry) =>
      [entry.title, ...entry.rows.map(([label, value]) => `  ${label}: ${value}`)].join("\n"),
    )
    .join("\n\n");

/** How a quality option reads in the menu: "Original", "1080p". */
export const qualityOptionLabel = (option: QualityOption): string =>
  option.id === "original" ? "Original" : option.id;

/** What is on screen now: "Original", "720p". */
export const qualityPlayingLabel = (quality: PlayerQuality): string => {
  const playing = quality.options.find((option) => option.id === quality.playing);
  return playing === undefined ? quality.playing : qualityOptionLabel(playing);
};

/** The quality as the settings row shows it: "Auto (720p)", "Original", "480p". */
export const qualityLabel = (quality: PlayerQuality): string => {
  const playingLabel = qualityPlayingLabel(quality);
  if (quality.choice === "auto") return `Auto (${playingLabel})`;
  const chosen = quality.options.find((option) => option.id === quality.choice);
  return chosen === undefined ? playingLabel : qualityOptionLabel(chosen);
};

/** The badge on the settings button for what is on screen, as video sites mark it. */
export const qualityBadge = (quality: PlayerQuality): string | null => {
  const height = quality.options.find((option) => option.id === quality.playing)?.height ?? null;
  if (height === null) return null;
  return height >= 2160 ? "4K" : height >= 720 ? "HD" : null;
};
