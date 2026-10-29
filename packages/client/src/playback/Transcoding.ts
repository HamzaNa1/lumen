export interface TranscodingPlan {
  readonly format: "mp4" | "webm";
  readonly audioIndex: number;
  readonly video: "copy" | "h264" | "vp8" | "none";
  readonly audio: "copy" | "aac" | "opus";
}

export const setTranscodingParameters = (url: URL, plan: TranscodingPlan, start: number): void => {
  url.searchParams.set("transcode", "1");
  url.searchParams.set("format", plan.format);
  url.searchParams.set("video", plan.video);
  url.searchParams.set("audio", plan.audio);
  url.searchParams.set("audioIndex", String(plan.audioIndex));
  url.searchParams.set("start", String(start));
};
