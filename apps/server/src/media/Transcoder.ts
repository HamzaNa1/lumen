import { spawn } from "node:child_process";
import type { TranscodingConfig } from "../config/TranscodingConfig";
import { badRequest, ServerError } from "../core/Errors";

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
  constructor(private readonly config: TranscodingConfig) {}

  stop(sessionId: string, userId: string): void {
    for (const job of this.jobs)
      if (job.sessionId === sessionId && job.userId === userId) job.stop();
  }

  async serve(
    request: Request,
    media: { absolutePath: string; sessionId: string; userId: string },
    authorize: () => Promise<unknown>,
  ): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const video = params.get("video") ?? "copy";
    const audio = params.get("audio") ?? "copy";
    const audioIndex = Number(params.get("audioIndex") ?? 0);
    const start = Number(params.get("start") ?? 0);
    if (
      !["copy", "h264"].includes(video) ||
      !["copy", "aac"].includes(audio) ||
      !Number.isSafeInteger(audioIndex) ||
      audioIndex < 0 ||
      audioIndex > 1024 ||
      !Number.isFinite(start) ||
      start < 0 ||
      start > 604800
    )
      throw badRequest("Invalid transcoding parameters");
    if (!this.config.enabled) throw unavailable("Transcoding is disabled on this server");
    const headers = {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "accept-ranges": "none",
    };
    if (request.method === "HEAD") return new Response(null, { headers });
    if (request.signal.aborted) throw badRequest("Playback request was cancelled");
    const previous = [...this.jobs].filter((job) => job.sessionId === media.sessionId);
    for (const job of previous) job.stop();
    await Promise.all(previous.map((job) => job.finished));
    if (request.signal.aborted) throw badRequest("Playback request was cancelled");
    if (this.jobs.size >= this.config.maxJobs) throw unavailable("All transcoding slots are busy");
    let gpu: string | null = null;
    if (video === "h264" && this.config.encoder !== "cpu") {
      const loads = this.config.gpus.map((device) => ({
        device,
        count: [...this.jobs].filter((job) => job.gpu === device).length,
      }));
      loads.sort((a, b) => a.count - b.count);
      const selected = loads[0];
      if (!selected || selected.count >= this.config.gpuJobs)
        throw unavailable("All GPU slots are busy");
      gpu = selected.device;
    }
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      String(this.config.threads),
      "-filter_threads",
      String(this.config.threads),
    ];
    if (gpu !== null && this.config.encoder === "vaapi") args.push("-vaapi_device", gpu);
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
    if (video === "copy") args.push("-c:v", "copy");
    else {
      args.push(
        "-c:v",
        this.config.encoder === "cpu"
          ? "libx264"
          : this.config.encoder === "nvenc"
            ? "h264_nvenc"
            : "h264_vaapi",
      );
      if (this.config.encoder === "cpu") args.push("-preset", "veryfast", "-crf", "23");
      if (gpu !== null && this.config.encoder === "nvenc") args.push("-gpu", gpu);
      args.push(
        "-vf",
        this.config.encoder === "vaapi" ? "format=nv12,hwupload" : "format=yuv420p",
        "-g",
        "48",
      );
    }
    args.push("-threads", String(this.config.threads), "-c:a", audio === "copy" ? "copy" : "aac");
    if (audio === "aac") args.push("-ac", "2", "-b:a", "192k");
    args.push(
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      "1000000",
      "-f",
      "mp4",
      "pipe:1",
    );
    const child = spawn(this.config.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
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
