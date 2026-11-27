/** What a Jellyfin device profile asks about a video track that Lumen's catalog does not hold. */
export interface VideoDetails {
  /** As ffprobe names it, such as "Main 10" or "High". */
  readonly profile: string | null;
  /** As ffprobe counts it: 41 for H.264 level 4.1, 150 for HEVC level 5. */
  readonly level: number | null;
  readonly bitDepth: number | null;
  readonly rangeType: VideoRangeType;
  readonly interlaced: boolean | null;
  readonly anamorphic: boolean | null;
  readonly refFrames: number | null;
  readonly codecTag: string | null;
  readonly frameRate: number | null;
}

export type VideoRangeType =
  | "SDR"
  | "HDR10"
  | "HLG"
  | "DOVI"
  | "DOVIWithHDR10"
  | "DOVIWithHLG"
  | "DOVIWithSDR";

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RUNNING = 4;
const MAX_CACHED = 1000;

const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return typeof value !== "boolean" && value !== "" && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : null;
};

const rate = (value: unknown): number | null => {
  const [numerator, denominator] = String(value ?? "")
    .split("/")
    .map(Number);
  return numerator !== undefined && denominator !== undefined && numerator > 0 && denominator > 0
    ? Math.round((numerator / denominator) * 1000) / 1000
    : null;
};

/** Jellyfin's names for Dolby Vision by what its base layer falls back to. */
const dolbyVision: Record<number, VideoRangeType> = {
  0: "DOVI",
  1: "DOVIWithHDR10",
  2: "DOVIWithSDR",
  4: "DOVIWithHLG",
  6: "DOVIWithHDR10",
};

/** Reads the first video stream of `ffprobe -show_streams` JSON; null when there is none. */
export const parseVideoDetails = (output: unknown): VideoDetails | null => {
  const streams = (output as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return null;
  const stream = streams.find(
    (candidate) => (candidate as { codec_type?: unknown }).codec_type === "video",
  ) as Record<string, unknown> | undefined;
  if (stream === undefined) return null;
  const sideData = Array.isArray(stream.side_data_list)
    ? (stream.side_data_list as ReadonlyArray<Record<string, unknown>>)
    : [];
  const vision = sideData.find((entry) => entry.side_data_type === "DOVI configuration record");
  const transfer = stream.color_transfer;
  const rangeType: VideoRangeType =
    vision !== undefined
      ? (dolbyVision[Number(vision.dv_bl_signal_compatibility_id)] ?? "DOVI")
      : transfer === "smpte2084"
        ? "HDR10"
        : transfer === "arib-std-b67"
          ? "HLG"
          : "SDR";
  const pixelFormat = typeof stream.pix_fmt === "string" ? stream.pix_fmt : "";
  const fieldOrder = typeof stream.field_order === "string" ? stream.field_order : null;
  const aspect = typeof stream.sample_aspect_ratio === "string" ? stream.sample_aspect_ratio : null;
  return {
    profile: typeof stream.profile === "string" ? stream.profile : null,
    level: number(stream.level),
    bitDepth:
      number(stream.bits_per_raw_sample) ??
      number(/p(\d{2})(?:le|be)$/u.exec(pixelFormat)?.[1]) ??
      (pixelFormat === "" ? null : 8),
    rangeType,
    interlaced:
      fieldOrder === null || fieldOrder === "unknown" ? null : fieldOrder !== "progressive",
    anamorphic: aspect === null || aspect === "0:1" || aspect === "N/A" ? null : aspect !== "1:1",
    refFrames: number(stream.refs),
    codecTag:
      typeof stream.codec_tag_string === "string" && !stream.codec_tag_string.startsWith("[")
        ? stream.codec_tag_string
        : null,
    frameRate: rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate),
  };
};

const readBounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > MAX_OUTPUT_BYTES) throw new Error("ffprobe output exceeded limit");
  }
  return text + decoder.decode();
};

/**
 * Probes a file's video track the first time a Jellyfin app asks to play it, and remembers the
 * answer for those exact bytes. A probe that fails, or one more than the server runs at once,
 * answers unknown, so the app's own rules for unknown values decide.
 */
export class VideoProbe {
  private readonly known = new Map<string, Promise<VideoDetails | null>>();
  private running = 0;

  constructor(private readonly executable = process.env.LUMEN_FFPROBE_PATH ?? "ffprobe") {}

  details(file: ProbedFile): Promise<VideoDetails | null> {
    const found = this.known.get(key(file));
    if (found !== undefined) return found;
    if (this.running >= MAX_RUNNING) return Promise.resolve(null);
    this.running += 1;
    const probe = this.run(file.absolutePath)
      .catch(() => null)
      .finally(() => {
        this.running -= 1;
      });
    this.known.set(key(file), probe);
    // A failure is not remembered, so the next play tries again.
    void probe.then((details) => {
      if (details === null) this.known.delete(key(file));
    });
    if (this.known.size > MAX_CACHED) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
    return probe;
  }

  private async run(absolutePath: string): Promise<VideoDetails | null> {
    const child = Bun.spawn(
      [
        this.executable,
        ...["-v", "error", "-protocol_whitelist", "file", "-print_format", "json"],
        ...["-select_streams", "V:0", "-show_streams", absolutePath],
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    try {
      const output = await readBounded(child.stdout as ReadableStream<Uint8Array>);
      if ((await child.exited) !== 0) return null;
      return parseVideoDetails(JSON.parse(output) as unknown);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
}

export interface ProbedFile {
  readonly absolutePath: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

const key = (file: ProbedFile) => `${file.absolutePath}\n${file.size}\n${file.modifiedAtMs}`;
