export interface TranscodingConfig {
  readonly enabled: boolean;
  readonly ffmpeg: string;
  readonly threads: number;
  readonly maxJobs: number;
  readonly gpuJobs: number;
  readonly gpus: ReadonlyArray<string>;
  readonly encoder: "cpu" | "nvenc" | "vaapi";
}

export const transcodingConfig = (env: Record<string, string | undefined>): TranscodingConfig => {
  const integer = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${key} must be an integer between 1 and ${max}`);
    return value;
  };
  const enabled = env.LUMEN_TRANSCODING_ENABLED ?? "true";
  if (enabled !== "true" && enabled !== "false")
    throw new Error("LUMEN_TRANSCODING_ENABLED must be true or false");
  const encoder = env.LUMEN_TRANSCODING_ENCODER ?? "cpu";
  if (encoder !== "cpu" && encoder !== "nvenc" && encoder !== "vaapi")
    throw new Error("LUMEN_TRANSCODING_ENCODER must be cpu, nvenc or vaapi");
  const gpus = (env.LUMEN_TRANSCODING_GPUS ?? (encoder === "vaapi" ? "/dev/dri/renderD128" : "0"))
    .split(",")
    .map((gpu) => gpu.trim());
  if (
    new Set(gpus).size !== gpus.length ||
    gpus.some((gpu) =>
      encoder === "vaapi" ? !/^\/dev\/dri\/renderD\d+$/.test(gpu) : !/^\d+$/.test(gpu),
    )
  )
    throw new Error("LUMEN_TRANSCODING_GPUS must list unique GPU indices or VAAPI render devices");
  return {
    enabled: enabled === "true",
    encoder,
    gpus,
    ffmpeg: env.LUMEN_FFMPEG_PATH ?? "ffmpeg",
    threads: integer("LUMEN_TRANSCODING_THREADS", 2, 256),
    maxJobs: integer("LUMEN_TRANSCODING_MAX_JOBS", 4, 128),
    gpuJobs: integer("LUMEN_TRANSCODING_GPU_JOBS", 2, 32),
  };
};
