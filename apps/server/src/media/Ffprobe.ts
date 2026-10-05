import { Context, Effect, Layer, Schema } from "effect";
import type { ServerConfig } from "../config/Config";
import { runMediaProcess } from "./MediaProcess";

const FfprobeOutput = Schema.Struct({
  format: Schema.optional(
    Schema.Struct({
      duration: Schema.optional(Schema.String),
      start_time: Schema.optional(Schema.String),
      format_name: Schema.optional(Schema.String),
      tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  streams: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      codec_type: Schema.String,
      codec_name: Schema.optional(Schema.String),
      profile: Schema.optional(Schema.String),
      level: Schema.optional(Schema.Int),
      pix_fmt: Schema.optional(Schema.String),
      start_time: Schema.optional(Schema.String),
      bit_rate: Schema.optional(Schema.String),
      sample_rate: Schema.optional(Schema.String),
      channels: Schema.optional(Schema.Int),
      width: Schema.optional(Schema.Int),
      height: Schema.optional(Schema.Int),
      tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      disposition: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
    }),
  ),
});

export interface FfprobeResult {
  readonly durationMs: number | null;
  readonly startSeconds?: number | null;
  readonly container?: string | null;
  readonly streams: ReadonlyArray<{
    readonly kind: "audio" | "video" | "subtitle";
    readonly ordinal: number;
    readonly codec: string | null;
    readonly profile?: string | null;
    readonly level?: number | null;
    readonly pixelFormat?: string | null;
    readonly startSeconds?: number | null;
    readonly bitrate: number | null;
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly language: string | null;
    readonly title: string | null;
    readonly isDefault: boolean;
  }>;
  readonly tags: Readonly<Record<string, string>>;
}

const asNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const finiteNumber = (value: string | undefined): number | null => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseProbeOutput = (output: unknown): FfprobeResult => {
  const value = Schema.decodeUnknownSync(FfprobeOutput)(output);
  const duration = finiteNumber(value.format?.duration);
  return {
    durationMs: duration === null || duration < 0 ? null : Math.round(duration * 1000),
    startSeconds: finiteNumber(value.format?.start_time),
    container: value.format?.format_name ?? null,
    tags: value.format?.tags ?? {},
    streams: value.streams.flatMap((stream) => {
      if (
        stream.codec_type !== "audio" &&
        stream.codec_type !== "video" &&
        stream.codec_type !== "subtitle"
      )
        return [];
      return [
        {
          kind: stream.codec_type,
          ordinal: stream.index,
          codec: stream.codec_name ?? null,
          profile: stream.profile ?? null,
          level: stream.level ?? null,
          pixelFormat: stream.pix_fmt ?? null,
          startSeconds: finiteNumber(stream.start_time),
          bitrate: asNumber(stream.bit_rate),
          sampleRateHz: asNumber(stream.sample_rate),
          channels: asNumber(stream.channels?.toString()),
          width: asNumber(stream.width?.toString()),
          height: asNumber(stream.height?.toString()),
          language: stream.tags?.language ?? null,
          title: stream.tags?.title ?? null,
          isDefault: stream.disposition?.default === 1,
        },
      ];
    }),
  };
};

export const probeFile = async (
  executable: string,
  absolutePath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<FfprobeResult> => {
  const output = await runMediaProcess(
    [
      executable,
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      absolutePath,
    ],
    { timeoutMs, maxOutputBytes, signal },
  );
  return parseProbeOutput(JSON.parse(output) as unknown);
};

export interface FfprobeShape {
  readonly probe: (absolutePath: string) => Effect.Effect<FfprobeResult, unknown>;
}

export const makeFfprobe = (config: ServerConfig) =>
  Effect.gen(function* () {
    const probe: FfprobeShape["probe"] = Effect.fn("Ffprobe.probe")(function* (absolutePath) {
      return yield* Effect.tryPromise({
        try: (signal) =>
          probeFile(
            config.ffprobePath,
            absolutePath,
            config.ffprobeTimeoutMs,
            config.ffprobeMaxOutputBytes,
            signal,
          ),
        catch: (cause) => (cause instanceof Error ? cause : new Error("ffprobe failed")),
      });
    });
    return { probe };
  });

export class Ffprobe extends Context.Service<Ffprobe, FfprobeShape>()("@lumen/server/Ffprobe") {}
export const FfprobeLive = (config: ServerConfig) => Layer.effect(Ffprobe, makeFfprobe(config));
