import type { TranscodingSettings } from "@lumen/contracts";

export const H264_ENCODERS = {
  cpu: { name: "libx264", profile: "baseline" },
  nvenc: { name: "h264_nvenc", profile: "baseline" },
  vaapi: { name: "h264_vaapi", profile: "constrained_baseline" },
} as const satisfies Record<
  TranscodingSettings["encoder"],
  { readonly name: string; readonly profile: string }
>;
