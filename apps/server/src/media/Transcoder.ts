import { spawn } from "node:child_process";
import type { TranscodingSettings } from "@lumen/contracts";
import { badRequest, ServerError } from "../core/Errors";
import { H264_ENCODERS } from "./VideoEncoders";

const unavailable = (message: string) =>
  new ServerError({ status: 503, code: "service_unavailable", message });

interface Job {
  readonly sessionId: string;
  readonly userId: string;
  readonly gpu: string | null;
  readonly stop: () => void;
  readonly finished: Promise<void>;
}

/** Owns live encoders; slots are released only after the child actually exits. */
export class Transcoder {
  private readonly jobs = new Set<Job>();
  private readonly starts = new Map<string, { readonly userId: string; readonly id: symbol }>();
  constructor(private readonly settings: () => Promise<TranscodingSettings>) {}

  stopAll(): void {
    this.starts.clear();
    for (const job of this.jobs) job.stop();
  }

  stop(sessionId: string, userId: string): void {
    if (this.starts.get(sessionId)?.userId === userId) this.starts.delete(sessionId);
    for (const job of this.jobs)
      if (job.sessionId === sessionId && job.userId === userId) job.stop();
  }

  async serve(
    request: Request,
    media: { absolutePath: string; sessionId: string; userId: string },
    authorize: () => Promise<unknown>,
  ): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const requestedVideo = params.get("video") ?? "copy";
    const requestedAudio = params.get("audio") ?? "copy";
    const format = params.get("format") ?? "mp4";
    const audioIndex = Number(params.get("audioIndex") ?? 0);
    const start = Number(params.get("start") ?? 0);
    if (
      !["copy", "h264", "vp8", "none"].includes(requestedVideo) ||
      !["copy", "aac", "opus"].includes(requestedAudio) ||
      !["mp4", "webm"].includes(format) ||
      (format === "webm" &&
        ((requestedVideo !== "vp8" && requestedVideo !== "none") || requestedAudio !== "opus")) ||
      !Number.isSafeInteger(audioIndex) ||
      audioIndex < 0 ||
      audioIndex > 1024 ||
      !Number.isFinite(start) ||
      start < 0 ||
      start > 604800
    )
      throw badRequest("Invalid transcoding parameters");
    const audio = start > 0 && requestedAudio === "copy" ? "aac" : requestedAudio;
    const video = start > 0 && requestedVideo === "copy" ? "h264" : requestedVideo;

    const headers = {
      "content-type": format === "webm" ? "video/webm" : "video/mp4",
      "cache-control": "no-store",
      "accept-ranges": "none",
    };
    if (request.method === "HEAD") {
      if (!(await this.settings()).enabled)
        throw unavailable("Transcoding is disabled on this server");
      return new Response(null, { headers });
    }
    if (request.signal.aborted) throw badRequest("Playback request was cancelled");
    const pending = Symbol();
    this.starts.set(media.sessionId, { userId: media.userId, id: pending });
    const previous = [...this.jobs].filter((job) => job.sessionId === media.sessionId);
    for (const job of previous) job.stop();
    await Promise.all(previous.map((job) => job.finished));
    let config: TranscodingSettings;
    try {
      config = await this.settings();
    } catch (cause) {
      if (this.starts.get(media.sessionId)?.id === pending) this.starts.delete(media.sessionId);
      throw cause;
    }
    if (this.starts.get(media.sessionId)?.id !== pending)
      throw badRequest("Playback request was superseded");
    this.starts.delete(media.sessionId);
    if (!config.enabled) throw unavailable("Transcoding is disabled on this server");
    if (request.signal.aborted) throw badRequest("Playback request was cancelled");
    if (this.jobs.size >= config.maxJobs) throw unavailable("All transcoding slots are busy");
    if (
      !config.softwareVideo &&
      (video === "vp8" || (video === "h264" && config.encoder === "cpu"))
    )
      throw unavailable("Software video encoding is disabled on this server");
    let gpu: string | null = null;
    if (video === "h264" && config.encoder !== "cpu") {
      const loads = config.gpus.map((device) => ({
        device,
        count: [...this.jobs].filter((job) => job.gpu === device).length,
      }));
      loads.sort((a, b) => a.count - b.count);
      const selected = loads[0];
      if (!selected || selected.count >= config.gpuJobs)
        throw unavailable("All GPU slots are busy");
      gpu = selected.device;
    }
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      String(config.threads),
      "-filter_threads",
      String(config.threads),
    ];
    if (gpu !== null && config.encoder === "vaapi") args.push("-vaapi_device", gpu);
    args.push(
      "-ss",
      String(start),
      "-i",
      media.absolutePath,
      "-map",
      "0:V:0?",
      "-map",
      `0:a:${audioIndex}?`,
      "-sn",
      "-dn",
    );
    if (video === "none") args.push("-vn");
    else if (video === "vp8")
      args.push(
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-cpu-used",
        "4",
        "-b:v",
        "4M",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
        "-g",
        "48",
      );
    else if (video === "copy") args.push("-c:v", "copy");
    else {
      const encoder = H264_ENCODERS[config.encoder];
      args.push("-c:v", encoder.name);
      if (config.encoder === "cpu") args.push("-preset", "veryfast", "-crf", "23");
      if (gpu !== null && config.encoder === "nvenc") args.push("-gpu", gpu);
      args.push("-profile:v", encoder.profile, "-bf", "0");
      args.push(
        "-vf",
        config.encoder === "vaapi"
          ? "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=nv12,hwupload"
          : "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
        "-g",
        "48",
      );
    }
    args.push(
      "-threads",
      String(config.threads),
      "-c:a",
      audio === "copy" ? "copy" : audio === "opus" ? "libopus" : "aac",
    );
    if (audio !== "copy") args.push("-ac", "2", "-b:a", "192k");
    if (format === "mp4")
      args.push(
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "1000000",
      );
    else args.push("-cluster_time_limit", "1000");
    args.push("-f", format, "pipe:1");
    const child = spawn(config.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    };
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job = { finished, sessionId: media.sessionId, userId: media.userId, gpu, stop };
    this.jobs.add(job);
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    // Also reclaim abandoned sessions and stalled consumers, even without a TCP disconnect.
    let lastRead = Date.now();
    const lease = setInterval(() => {
      if (Date.now() - lastRead > 60_000) stop();
      void authorize().catch(stop);
    }, 5000);
    lease.unref();
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(killTimer);
        clearInterval(lease);
        request.signal.removeEventListener("abort", stop);
        this.jobs.delete(job);
        finish();
        resolve(code);
      });
    });
    void closed.catch(() => {});
    // Drain stderr without retaining paths or unbounded decoder diagnostics.
    child.stderr.resume();
    const iterator = child.stdout[Symbol.asyncIterator]();
    let first: IteratorResult<Buffer>;
    const startup = setTimeout(stop, 20_000);
    try {
      first = await iterator.next();
      await authorize();
      if (first.done) throw unavailable("FFmpeg could not start playback");
    } catch {
      stop();
      throw unavailable("FFmpeg could not start playback");
    } finally {
      clearTimeout(startup);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first.value);
      },
      async pull(controller) {
        try {
          const chunk = await iterator.next();
          lastRead = Date.now();
          if (chunk.done) {
            const code = await closed;
            if (code !== 0) controller.error(new Error("Transcoding stopped"));
            else controller.close();
          } else controller.enqueue(chunk.value);
        } catch (cause) {
          stop();
          controller.error(cause);
        }
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, { headers });
  }
}
