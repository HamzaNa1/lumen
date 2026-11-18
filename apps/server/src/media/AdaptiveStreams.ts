import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTIVE_AUDIO_KBPS,
  ADAPTIVE_PIECE_SECONDS,
  type AdaptiveRendition,
  adaptivePieceCount,
  adaptivePieceSeconds,
  adaptiveRendition,
  adaptiveRenditionsFor,
  type TranscodingSettings,
} from "@lumen/contracts";
import { badRequest, notFound } from "../core/Errors";
import { probeFile } from "./Ffprobe";
import { type Transcoder, unavailable } from "./Transcoder";
import { H264_ENCODERS } from "./VideoEncoders";

/** The encoder stops once it is this many pieces past anything a client has asked for. */
const LEAD_PIECES = 30;
/** A request this close ahead of the running encoder waits for it rather than restarting it. */
const SOON_PIECES = 3;
const IDLE_MS = 60_000;
const PIECE_WAIT_MS = 30_000;
const POLL_MS = 150;

interface Probe {
  readonly durationSeconds: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly audioStreams: number;
}

interface Encoder {
  readonly rendition: AdaptiveRendition;
  readonly first: number;
  /** Pieces in [first, videoDone) and [first, audioDone) are complete on disk. */
  videoDone: number;
  audioDone: number;
  exited: boolean;
  failed: boolean;
  /** Advances videoDone and audioDone over pieces that have appeared on disk. */
  readonly scan: () => Promise<void>;
  readonly stop: () => void;
}

interface Session {
  readonly sessionId: string;
  readonly userId: string;
  readonly absolutePath: string;
  readonly audioIndex: number;
  readonly dir: string;
  readonly probe: Promise<Probe>;
  encoder: Encoder | null;
  /** The quality an audio request starts the encoder with when none is running. */
  lastRendition: AdaptiveRendition | null;
  furthest: number;
  lastRequestAt: number;
  restarting: Promise<void>;
  readonly waiters: Set<() => void>;
  poll: ReturnType<typeof setInterval> | null;
}

export interface AdaptiveRequest {
  readonly audioIndex: number;
  /** The path after the audio index, such as "master.m3u8" or "720p/12.ts". */
  readonly file: string;
}

/** `/api/v1/media/<track>/adaptive/<audioIndex>/<file>` */
export const adaptiveRequestFor = (pathname: string): AdaptiveRequest | null => {
  const match = /^\/api\/v1\/media\/[^/]+\/adaptive\/(\d{1,4})\/(.+)$/u.exec(pathname);
  if (match === null) return null;
  return { audioIndex: Number(match[1]), file: match[2] ?? "" };
};

const playlistHeaders = {
  "content-type": "application/vnd.apple.mpegurl",
  "cache-control": "no-store",
};

/** Whether a running encoder will cut this piece soon enough to wait for; null asks for audio. */
const covers = (encoder: Encoder | null, rendition: AdaptiveRendition | null, index: number) =>
  encoder !== null &&
  !encoder.exited &&
  encoder.first <= index &&
  (rendition === null
    ? index < encoder.audioDone + LEAD_PIECES
    : encoder.rendition === rendition && index < encoder.videoDone + SOON_PIECES);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Converts a file into pieces of several qualities that share their cut points, encoding only
 * the quality and position clients ask for. Each session runs at most one encoder, which takes
 * the session's transcoding slot; pieces live under the data directory until the session ends.
 */
export class AdaptiveStreams {
  private readonly sessions = new Map<string, Session>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly root: string,
    private readonly transcoder: Transcoder,
    private readonly settings: () => Promise<TranscodingSettings>,
    private readonly probe: (absolutePath: string) => Promise<Probe> = async (absolutePath) => {
      const result = await probeFile(
        process.env.LUMEN_FFPROBE_PATH ?? "ffprobe",
        absolutePath,
        15_000,
        4 * 1024 * 1024,
      );
      const video = result.streams.find((stream) => stream.kind === "video");
      return {
        durationSeconds: (result.durationMs ?? 0) / 1000,
        width: video?.width ?? null,
        height: video?.height ?? null,
        audioStreams: result.streams.filter((stream) => stream.kind === "audio").length,
      };
    },
  ) {
    // Pieces from before a restart belong to sessions that no longer exist.
    this.ready = rm(root, { recursive: true, force: true }).catch(() => {});
  }

  stop(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.userId === userId) this.dispose(session);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) this.dispose(session);
  }

  async serve(
    request: Request,
    media: { absolutePath: string; sessionId: string; userId: string },
    target: AdaptiveRequest,
    grant: string | null,
  ): Promise<Response> {
    if (request.method !== "GET") throw badRequest("Adaptive streams are read with GET");
    if (target.audioIndex > 1024) throw badRequest("Invalid audio track");
    if (!(await this.settings()).enabled)
      throw unavailable("Transcoding is disabled on this server");
    await this.ready;
    const session = this.session(media, target.audioIndex);
    session.lastRequestAt = Date.now();
    const probe = await session.probe.catch(() => {
      throw unavailable("The file could not be read for conversion");
    });
    if (probe.height === null) throw badRequest("Only video can be streamed adaptively");
    const renditions = adaptiveRenditionsFor(probe.height);
    const query = grant === null ? "" : `?grant=${encodeURIComponent(grant)}`;
    const pieces = adaptivePieceCount(probe.durationSeconds);
    const hasAudio = target.audioIndex < probe.audioStreams;

    if (target.file === "master.m3u8") {
      const width = (height: number) =>
        probe.width === null || probe.height === null
          ? null
          : Math.round((probe.width * height) / probe.height / 2) * 2;
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
      if (hasAudio)
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8${query}"`,
        );
      for (const rendition of renditions) {
        const resolution = width(rendition.height);
        const attributes = [
          `BANDWIDTH=${(rendition.maxKbps + (hasAudio ? ADAPTIVE_AUDIO_KBPS : 0)) * 1000}`,
          ...(resolution === null ? [] : [`RESOLUTION=${resolution}x${rendition.height}`]),
          `CODECS="avc1.4d4028${hasAudio ? ",mp4a.40.2" : ""}"`,
          ...(hasAudio ? ['AUDIO="audio"'] : []),
        ];
        lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, `${rendition.id}.m3u8${query}`);
      }
      return new Response(`${lines.join("\n")}\n`, { headers: playlistHeaders });
    }

    const playlist = /^(audio|\d{3,4}p)\.m3u8$/u.exec(target.file);
    if (playlist !== null) {
      const name = playlist[1] ?? "";
      if (name === "audio" ? !hasAudio : !renditions.some((r) => r.id === name))
        throw notFound("Stream not found");
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${ADAPTIVE_PIECE_SECONDS + 1}`,
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
      ];
      for (let index = 0; index < pieces; index += 1)
        lines.push(
          `#EXTINF:${adaptivePieceSeconds(probe.durationSeconds, index).toFixed(3)},`,
          `${name}/${index}.ts${query}`,
        );
      lines.push("#EXT-X-ENDLIST");
      return new Response(`${lines.join("\n")}\n`, { headers: playlistHeaders });
    }

    const piece = /^(audio|\d{3,4}p)\/(\d{1,6})\.ts$/u.exec(target.file);
    if (piece === null) throw notFound("Stream not found");
    const name = piece[1] ?? "";
    const index = Number(piece[2]);
    const rendition = name === "audio" ? null : adaptiveRendition(name);
    if (
      index >= pieces ||
      (name === "audio" ? !hasAudio : rendition === null || !renditions.includes(rendition))
    )
      throw notFound("Stream not found");
    return this.piece(session, rendition, index, request.signal, hasAudio, renditions);
  }

  private session(
    media: { absolutePath: string; sessionId: string; userId: string },
    audioIndex: number,
  ): Session {
    const existing = this.sessions.get(media.sessionId);
    if (
      existing !== undefined &&
      existing.audioIndex === audioIndex &&
      existing.absolutePath === media.absolutePath &&
      existing.userId === media.userId
    )
      return existing;
    if (existing !== undefined) this.dispose(existing);
    const session: Session = {
      sessionId: media.sessionId,
      userId: media.userId,
      absolutePath: media.absolutePath,
      audioIndex,
      dir: join(this.root, `${media.sessionId}-${audioIndex}`),
      probe: this.probe(media.absolutePath),
      encoder: null,
      lastRendition: null,
      furthest: 0,
      lastRequestAt: Date.now(),
      restarting: Promise.resolve(),
      waiters: new Set(),
      poll: null,
    };
    void session.probe.catch(() => {});
    this.sessions.set(media.sessionId, session);
    return session;
  }

  private dispose(session: Session): void {
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    session.encoder?.stop();
    if (session.poll !== null) clearInterval(session.poll);
    session.poll = null;
    for (const wake of session.waiters) wake();
    void rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }

  private async piece(
    session: Session,
    rendition: AdaptiveRendition | null,
    index: number,
    signal: AbortSignal,
    hasAudio: boolean,
    renditions: ReadonlyArray<AdaptiveRendition>,
  ): Promise<Response> {
    session.furthest = Math.max(session.furthest, index);
    if (rendition !== null) session.lastRendition = rendition;
    const path = join(session.dir, rendition?.id ?? "audio", `${index}.ts`);
    const deadline = Date.now() + PIECE_WAIT_MS;
    let restarts = 0;
    while (true) {
      if (signal.aborted) throw badRequest("Playback request was cancelled");
      if (this.sessions.get(session.sessionId) !== session)
        throw unavailable("Playback session ended");
      if (await exists(path)) {
        session.lastRequestAt = Date.now();
        const file = Bun.file(path);
        return new Response(file, {
          headers: {
            "content-type": "video/mp2t",
            "cache-control": "no-store",
            "content-length": String(file.size),
          },
        });
      }
      const encoder = session.encoder;
      if (!covers(encoder, rendition, index)) {
        if ((restarts > 0 && encoder?.failed === true) || restarts > 2)
          throw unavailable("FFmpeg could not convert this part of the file");
        restarts += 1;
        await this.restart(session, rendition, index, hasAudio, renditions);
        continue;
      }
      if (Date.now() > deadline) throw unavailable("Conversion is not keeping up");
      await new Promise<void>((resolve) => {
        const wake = () => {
          session.waiters.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        session.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** Serialized per session so concurrent requests cannot start two encoders. */
  private restart(
    session: Session,
    wanted: AdaptiveRendition | null,
    index: number,
    hasAudio: boolean,
    renditions: ReadonlyArray<AdaptiveRendition>,
  ): Promise<void> {
    const next = session.restarting.then(async () => {
      const current = session.encoder;
      // A restart queued ahead of this one may already cover the piece.
      if (covers(current, wanted, index)) return;
      // Audio follows the quality last asked for, not one a quality change just stopped.
      const rendition = wanted ?? session.lastRendition ?? renditions.at(-1);
      if (rendition === undefined) throw notFound("Stream not found");
      current?.stop();
      if (this.sessions.get(session.sessionId) !== session) return;
      await this.start(session, rendition, index, hasAudio);
    });
    session.restarting = next.catch(() => {});
    return next;
  }

  private async start(
    session: Session,
    rendition: AdaptiveRendition,
    first: number,
    hasAudio: boolean,
  ): Promise<void> {
    const { config, gpu } = await this.transcoder.admit(session.sessionId, "h264");
    const probe = await session.probe;
    const videoDir = join(session.dir, rendition.id);
    const audioDir = join(session.dir, "audio");
    await mkdir(videoDir, { recursive: true });
    await mkdir(audioDir, { recursive: true });

    const args = encoderArguments({
      config,
      gpu,
      input: session.absolutePath,
      rendition,
      first,
      audioIndex: hasAudio ? session.audioIndex : null,
      videoDir,
      audioDir,
    });
    const child = spawn(config.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.resume();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pieces = adaptivePieceCount(probe.durationSeconds);
    const scan = async () => {
      let changed = false;
      while (
        encoder.videoDone < pieces &&
        (await exists(join(videoDir, `${encoder.videoDone}.ts`)))
      ) {
        encoder.videoDone += 1;
        changed = true;
      }
      while (
        hasAudio &&
        encoder.audioDone < pieces &&
        (await exists(join(audioDir, `${encoder.audioDone}.ts`)))
      ) {
        encoder.audioDone += 1;
        changed = true;
      }
      if (changed) for (const wake of session.waiters) wake();
    };
    const encoder: Encoder = {
      rendition,
      first,
      videoDone: first,
      audioDone: hasAudio ? first : Number.MAX_SAFE_INTEGER,
      exited: false,
      failed: false,
      scan,
      stop: () => {
        if (encoder.exited) return;
        encoder.exited = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
        killTimer.unref();
      },
    };
    this.transcoder.track({
      sessionId: session.sessionId,
      userId: session.userId,
      gpu,
      stop: encoder.stop,
      finished,
    });
    session.encoder = encoder;
    const onClose = (code: number | null) => {
      clearTimeout(killTimer);
      const stopped = encoder.exited;
      encoder.exited = true;
      void scan().finally(() => {
        if (!stopped && code !== 0) encoder.failed = true;
        finish();
        for (const wake of session.waiters) wake();
      });
    };
    child.once("error", () => onClose(-1));
    child.once("close", onClose);
    if (session.poll === null)
      session.poll = setInterval(() => {
        if (Date.now() - session.lastRequestAt > IDLE_MS) {
          this.dispose(session);
          return;
        }
        const running = session.encoder;
        if (running === null || running.exited) return;
        void running.scan().then(() => {
          const lead = Math.min(running.videoDone, running.audioDone) - session.furthest;
          if (lead > LEAD_PIECES) running.stop();
        });
      }, POLL_MS);
    session.poll.unref?.();
  }
}

/** One FFmpeg run: a video-only quality and the session's audio, both cut on the shared grid. */
export const encoderArguments = (options: {
  readonly config: TranscodingSettings;
  readonly gpu: string | null;
  readonly input: string;
  readonly rendition: AdaptiveRendition;
  readonly first: number;
  readonly audioIndex: number | null;
  readonly videoDir: string;
  readonly audioDir: string;
}): ReadonlyArray<string> => {
  const { config, gpu, rendition, first } = options;
  const piece = ADAPTIVE_PIECE_SECONDS;
  const maxKbps = rendition.maxKbps;
  const threads = String(config.threads);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", threads];
  args.push("-filter_threads", threads);
  if (gpu !== null && config.encoder === "vaapi") args.push("-vaapi_device", gpu);
  // Source timestamps are kept so every run and quality places piece n at the same time.
  args.push("-ss", String(first * piece), "-copyts", "-start_at_zero", "-i", options.input);
  args.push("-map", "0:V:0", "-sn", "-dn", "-max_muxing_queue_size", "1024");
  const scale = `scale=-2:${rendition.height}:out_color_matrix=bt709:out_range=tv`;
  args.push(
    "-vf",
    config.encoder === "vaapi" ? `${scale},format=nv12,hwupload` : `${scale},format=yuv420p`,
  );
  args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709");
  args.push("-c:v", H264_ENCODERS[config.encoder].name, "-g", "100000");
  const target = `${Math.round(maxKbps * 0.7)}k`;
  // Quality-led rate control, capped so each piece stays within its quality's budget.
  const rateControl = {
    cpu: ["-preset", "veryfast", "-crf", "23", "-sc_threshold", "0", "-forced-idr", "1"],
    nvenc: ["-rc", "vbr", "-cq", "25", "-b:v", target, "-no-scenecut", "1", "-forced-idr", "1"],
    vaapi: ["-rc_mode", "VBR", "-b:v", target, "-bf", "0"],
  }[config.encoder];
  args.push(...rateControl, "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`);
  if (gpu !== null && config.encoder === "nvenc") args.push("-gpu", gpu);
  args.push("-profile:v", "main");
  // A keyframe on the first frame at or after every multiple of the piece length.
  args.push(
    "-force_key_frames",
    `expr:if(isnan(prev_forced_t),1,gte(t,${piece}*(floor((prev_forced_t+0.001)/${piece})+1)-0.001))`,
  );
  const hls = (dir: string, seconds: number) => [
    "-f",
    "hls",
    "-hls_time",
    String(seconds),
    "-hls_list_size",
    "0",
    "-hls_flags",
    "temp_file",
    "-hls_segment_type",
    "mpegts",
    "-start_number",
    String(first),
    "-hls_segment_filename",
    join(dir, "%d.ts"),
    join(dir, `run-${first}.m3u8`),
  ];
  // Keyframes fall only on the grid, so cutting at every keyframe cuts exactly on it.
  args.push(...hls(options.videoDir, 0.1));
  if (options.audioIndex !== null) {
    args.push("-map", `0:a:${options.audioIndex}`, "-c:a", "aac", "-ac", "2");
    args.push("-b:a", `${ADAPTIVE_AUDIO_KBPS}k`, ...hls(options.audioDir, piece));
  }
  return args;
};
