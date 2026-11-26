import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Transcoder } from "../media/Transcoder";
import { unavailable } from "../media/Transcoder";
import type { SubtitleFormat } from "./PlaybackDecision";

const EXTRACT_TIMEOUT_MS = 120_000;

const codecs: Record<SubtitleFormat, ReadonlyArray<string>> = {
  vtt: ["-c:s", "webvtt", "-f", "webvtt"],
  srt: ["-c:s", "srt", "-f", "srt"],
  ass: ["-c:s", "ass", "-f", "ass"],
};

export const subtitleMimeTypes: Record<SubtitleFormat, string> = {
  vtt: "text/vtt; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  ass: "text/x-ssa; charset=utf-8",
};

export interface SubtitleRequest {
  readonly input: string;
  /** Names the file's exact bytes, so a replaced file is extracted again. */
  readonly cacheName: string;
  readonly index: number;
  readonly format: SubtitleFormat;
  /** What the run counts against in the transcoding limits. */
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Copies one embedded text subtitle out of a file with FFmpeg, into the data directory and never
 * beside the media. Each run takes a transcoding slot, and identical requests share one run.
 */
export class SubtitleExtractor {
  private readonly running = new Map<string, Promise<string>>();

  constructor(
    private readonly root: string,
    private readonly transcoder: Transcoder,
  ) {}

  extract(request: SubtitleRequest): Promise<string> {
    const path = join(this.root, `${request.cacheName}-${request.index}.${request.format}`);
    const existing = this.running.get(path);
    if (existing !== undefined) return existing;
    const run = this.run(request, path).finally(() => this.running.delete(path));
    this.running.set(path, run);
    return run;
  }

  private async run(request: SubtitleRequest, path: string): Promise<string> {
    if (
      await stat(path).then(
        (details) => details.isFile(),
        () => false,
      )
    )
      return path;
    const sessionId = `${request.sessionId}-subtitle-${request.index}`;
    const { config } = await this.transcoder.admit(sessionId, "copy");
    await mkdir(this.root, { recursive: true });
    const partial = `${path}.${crypto.randomUUID()}.partial`;
    const child = spawn(
      config.ffmpeg,
      [
        ...["-hide_banner", "-loglevel", "error", "-nostdin", "-i", request.input],
        ...["-map", `0:${request.index}`, ...codecs[request.format], partial],
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.resume();
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = () => child.kill("SIGKILL");
    this.transcoder.track({ sessionId, userId: request.userId, gpu: null, stop, finished });
    const timeout = setTimeout(stop, EXTRACT_TIMEOUT_MS);
    try {
      const code = await new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(-1));
        child.once("close", resolve);
      });
      if (code !== 0) throw unavailable("FFmpeg could not extract this subtitle");
      await rename(partial, path);
      return path;
    } finally {
      clearTimeout(timeout);
      finish();
      await rm(partial, { force: true });
    }
  }
}
