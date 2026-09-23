import { Context, Effect, Layer, Schema } from "effect";
import type { ServerConfig } from "../config/Config";

const FfprobeOutput = Schema.Struct({
  format: Schema.optional(Schema.Struct({
    duration: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  })),
  streams: Schema.Array(Schema.Struct({
    codec_type: Schema.String,
    codec_name: Schema.optional(Schema.String),
    bit_rate: Schema.optional(Schema.String),
    sample_rate: Schema.optional(Schema.String),
    channels: Schema.optional(Schema.Int),
    width: Schema.optional(Schema.Int),
    height: Schema.optional(Schema.Int),
    tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  })),
});

export interface FfprobeResult {
  readonly durationMs: number | null;
  readonly streams: ReadonlyArray<{
    readonly kind: "audio" | "video" | "subtitle";
    readonly codec: string | null;
    readonly bitrate: number | null;
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly language: string | null;
  }>;
  readonly tags: Readonly<Record<string, string>>;
}

const asNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parse = (output: unknown): FfprobeResult => {
  const value = Schema.decodeUnknownSync(FfprobeOutput)(output);
  const duration = asNumber(value.format?.duration);
  return {
    durationMs: duration === null ? null : Math.round(duration * 1000),
    tags: value.format?.tags ?? {},
    streams: value.streams.flatMap((stream) => {
      if (stream.codec_type !== "audio" && stream.codec_type !== "video" && stream.codec_type !== "subtitle") return [];
      return [{
        kind: stream.codec_type,
        codec: stream.codec_name ?? null,
        bitrate: asNumber(stream.bit_rate),
        sampleRateHz: asNumber(stream.sample_rate),
        channels: asNumber(stream.channels?.toString()),
        width: asNumber(stream.width?.toString()),
        height: asNumber(stream.height?.toString()),
        language: stream.tags?.language ?? null,
      }];
    }),
  };
};

const readBounded = async (stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("ffprobe output exceeded limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export const probeFile = (
  executable: string,
  absolutePath: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<FfprobeResult> => {
  const child = Bun.spawn([executable, "-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", absolutePath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("ffprobe timed out"));
    }, timeoutMs);
  });
  return Promise.race([
    (async () => {
      const output = await readBounded(child.stdout as ReadableStream<Uint8Array>, maxOutputBytes);
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`ffprobe exited with ${exitCode}`);
      return parse(JSON.parse(output) as unknown);
    })(),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

export interface FfprobeShape {
  readonly probe: (absolutePath: string) => Effect.Effect<FfprobeResult, unknown>;
}

export const makeFfprobe = (config: ServerConfig) => Effect.gen(function* () {
  const probe: FfprobeShape["probe"] = Effect.fn("Ffprobe.probe")(function* (absolutePath) {
    return yield* Effect.tryPromise({
      try: () => probeFile(process.env.LUMEN_FFPROBE_PATH ?? "ffprobe", absolutePath, config.ffprobeTimeoutMs, config.ffprobeMaxOutputBytes),
      catch: (cause) => cause instanceof Error ? cause : new Error("ffprobe failed"),
    });
  });
  return { probe };
});

export class Ffprobe extends Context.Service<Ffprobe, FfprobeShape>()("@lumen/server/Ffprobe") {}
export const FfprobeLive = (config: ServerConfig) => Layer.effect(Ffprobe, makeFfprobe(config));
