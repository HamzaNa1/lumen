import { Schema } from "effect";

const limit = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));
export const TranscodingSettings = Schema.Struct({
  enabled: Schema.Boolean,
  softwareVideo: Schema.Boolean,
  ffmpeg: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1024),
    Schema.isPattern(/^[^\0]+$/),
  ),
  threads: limit(256),
  maxJobs: limit(128),
  gpuJobs: limit(32),
  gpus: Schema.Array(Schema.String),
  encoder: Schema.Literals(["cpu", "nvenc", "vaapi"]),
}).check(
  Schema.makeFilter(
    (value) =>
      value.ffmpeg.trim().length > 0 &&
      value.gpus.length > 0 &&
      value.gpus.length <= 32 &&
      new Set(value.gpus).size === value.gpus.length &&
      value.gpus.every((gpu) =>
        value.encoder === "vaapi" ? /^\/dev\/dri\/renderD\d+$/.test(gpu) : /^\d+$/.test(gpu),
      ),
  ),
);
export type TranscodingSettings = Schema.Schema.Type<typeof TranscodingSettings>;
export const DEFAULT_TRANSCODING_SETTINGS: TranscodingSettings = {
  enabled: true,
  softwareVideo: true,
  ffmpeg: "ffmpeg",
  threads: 2,
  maxJobs: 4,
  gpuJobs: 2,
  gpus: ["0"],
  encoder: "cpu",
};
