import type { ServerResponse } from "node:http";
import {
  decideAdaptive,
  type FetchLike,
  type PlaybackDiagnostics,
  type ThroughputEstimator,
  upgradeFrom,
} from "@lumen/client";
import { ADAPTIVE_PIECE_SECONDS, type AdaptiveRendition } from "@lumen/contracts";
import { ignoreFailure } from "../failures";

/** How far ahead of the playhead pieces are fetched; MPV itself reads only a little of it. */
const AHEAD_SECONDS = 60;
/** Pieces behind the playhead kept for a short step back. */
const BEHIND_PIECES = 2;
const FETCH_ATTEMPTS = 4;

interface Piece {
  readonly bytes: Buffer;
  /** Null for audio. */
  readonly rendition: AdaptiveRendition | null;
}

interface Lane {
  readonly kind: "video" | "audio";
  readonly held: Map<number, Piece>;
  /** Pieces MPV is waiting for. */
  readonly waiting: Map<number, Set<() => void>>;
  fetching: { readonly index: number; readonly controller: AbortController } | null;
}

/**
 * The desktop's side of adaptive playback. MPV reads one plain HLS stream from the bridge; this
 * decides, piece by piece, which of the server's qualities fills it. Pieces are fetched ahead of
 * the playhead and kept in memory. A worse piece is replaced only once a better one has arrived,
 * so stepping up never leaves a gap, and a step down keeps whatever is already held.
 */
export class AdaptiveStream {
  private readonly video: Lane = {
    kind: "video",
    held: new Map(),
    waiting: new Map(),
    fetching: null,
  };
  private readonly audio: Lane = {
    kind: "audio",
    held: new Map(),
    waiting: new Map(),
    fetching: null,
  };
  private durations: ReadonlyArray<number> = [];
  private starts: ReadonlyArray<number> = [];
  private hasAudio = false;
  private loading: AdaptiveRendition;
  private choice: string;
  private positionSeconds: number;
  private closed = false;

  constructor(
    private readonly options: {
      readonly serverOrigin: string;
      /** The server's adaptive path for this session and audio track, without a file name. */
      readonly basePath: string;
      readonly bearer: string;
      readonly renditions: ReadonlyArray<AdaptiveRendition>;
      readonly start: AdaptiveRendition;
      /** "auto" or a rendition id. */
      readonly choice: string;
      readonly startSeconds: number;
      readonly estimator: ThroughputEstimator;
      readonly fetchImpl?: FetchLike;
      readonly diagnostics?: PlaybackDiagnostics;
      readonly onChange?: () => void;
    },
  ) {
    this.loading = options.start;
    this.choice = options.choice;
    this.positionSeconds = options.startSeconds;
  }

  /** Reads the server's piece list; the stream cannot be served before this settles. */
  async open(): Promise<void> {
    const master = await this.text("master.m3u8");
    this.hasAudio = master.includes("TYPE=AUDIO");
    const playlist = await this.text(`${this.options.renditions.at(-1)?.id ?? "360p"}.m3u8`);
    this.durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/gu)].map((match) => Number(match[1]));
    let total = 0;
    this.starts = this.durations.map((duration) => {
      const start = total;
      total += duration;
      return start;
    });
    if (this.durations.length === 0) throw new Error("The server listed no pieces to play");
    void this.pump();
  }

  close(): void {
    this.closed = true;
    for (const lane of [this.video, this.audio]) {
      lane.fetching?.controller.abort();
      lane.held.clear();
      for (const waiters of lane.waiting.values()) for (const wake of waiters) wake();
      lane.waiting.clear();
    }
  }

  get loadingRendition(): AdaptiveRendition {
    return this.loading;
  }

  /** What is on screen: the quality of the piece under the playhead. */
  get playingRendition(): AdaptiveRendition {
    return this.video.held.get(this.indexAt(this.positionSeconds))?.rendition ?? this.loading;
  }

  /** Contiguous seconds held from the playhead on. */
  get bufferAheadSeconds(): number {
    let index = this.indexAt(this.positionSeconds);
    let end = this.positionSeconds;
    while (
      this.video.held.has(index) &&
      (!this.hasAudio || this.audio.held.has(index)) &&
      index < this.durations.length
    ) {
      end = (this.starts[index] ?? 0) + (this.durations[index] ?? 0);
      index += 1;
    }
    return Math.max(0, end - this.positionSeconds);
  }

  /** The playhead as MPV reports it, which decides what to fetch and what to let go. */
  setPosition(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    this.positionSeconds = seconds;
    const first = this.indexAt(seconds) - BEHIND_PIECES;
    for (const lane of [this.video, this.audio])
      for (const index of lane.held.keys()) if (index < first) lane.held.delete(index);
    void this.pump();
  }

  /** "auto" or a rendition id; a manual choice shows within a couple of pieces. */
  choose(choice: string): void {
    this.choice = choice;
    const chosen = this.options.renditions.find((rendition) => rendition.id === choice);
    if (chosen !== undefined && chosen !== this.loading) {
      this.loading = chosen;
      this.options.onChange?.();
    }
    void this.pump();
  }

  /** Answers MPV: the playlists, and pieces from what is held or about to be. */
  async serve(path: string, method: string, response: ServerResponse): Promise<void> {
    const playlist = (body: string) =>
      response
        .writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl",
          "content-length": Buffer.byteLength(body),
        })
        .end(method === "HEAD" ? undefined : body);
    if (path === "master.m3u8") {
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
      if (this.hasAudio)
        lines.push(
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
        );
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${this.loading.maxKbps * 1000}${this.hasAudio ? ',AUDIO="audio"' : ""}`,
        "video.m3u8",
      );
      playlist(`${lines.join("\n")}\n`);
      return;
    }
    if (path === "video.m3u8" || (path === "audio.m3u8" && this.hasAudio)) {
      const prefix = path === "video.m3u8" ? "v" : "a";
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${ADAPTIVE_PIECE_SECONDS + 1}`,
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
      ];
      this.durations.forEach((duration, index) => {
        lines.push(`#EXTINF:${duration.toFixed(3)},`, `${prefix}/${index}.ts`);
      });
      lines.push("#EXT-X-ENDLIST");
      playlist(`${lines.join("\n")}\n`);
      return;
    }
    const match = /^([va])\/(\d+)\.ts$/u.exec(path);
    const index = Number(match?.[2]);
    if (match === null || !(index < this.durations.length)) {
      response.writeHead(404).end();
      return;
    }
    const lane = match[1] === "v" ? this.video : this.audio;
    const piece = await this.piece(lane, index, response);
    if (piece === null) {
      if (!response.headersSent) response.writeHead(this.closed ? 404 : 502).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "video/mp2t", "content-length": piece.bytes.length })
      .end(method === "HEAD" ? undefined : piece.bytes);
  }

  private async piece(lane: Lane, index: number, response: ServerResponse): Promise<Piece | null> {
    // MPV reads ahead of what it shows; what it asks for is at least where the fetching must be.
    if (lane === this.video && index < this.indexAt(this.positionSeconds) - BEHIND_PIECES)
      this.positionSeconds = this.starts[index] ?? this.positionSeconds;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS * 2; attempt += 1) {
      const held = lane.held.get(index);
      if (held !== undefined) return held;
      if (this.closed || response.destroyed) return null;
      await new Promise<void>((resolve) => {
        const waiters = lane.waiting.get(index) ?? new Set();
        const wake = () => {
          waiters.delete(wake);
          if (waiters.size === 0) lane.waiting.delete(index);
          response.off("close", wake);
          resolve();
        };
        waiters.add(wake);
        lane.waiting.set(index, waiters);
        response.once("close", wake);
        // A request away from what is being fetched, as after a seek, comes first.
        if (
          lane.fetching !== null &&
          lane.fetching.index !== index &&
          !this.isWanted(lane, lane.fetching.index)
        )
          lane.fetching.controller.abort();
        void this.pump();
      });
    }
    return lane.held.get(index) ?? null;
  }

  private isWanted(lane: Lane, index: number): boolean {
    return lane.waiting.has(index);
  }

  private indexAt(seconds: number): number {
    let index = 0;
    while (index + 1 < this.starts.length && (this.starts[index + 1] ?? 0) <= seconds + 0.001)
      index += 1;
    return index;
  }

  private decide(): void {
    if (this.choice !== "auto") return;
    const { estimator } = this.options;
    const decision = decideAdaptive({
      renditions: this.options.renditions,
      loading: this.loading,
      estimateKbps: estimator.kbps,
      bufferAheadSeconds: this.bufferAheadSeconds,
      secondsSinceSample:
        estimator.sampledAtMs === null
          ? Number.POSITIVE_INFINITY
          : (Date.now() - estimator.sampledAtMs) / 1000,
    });
    if (decision.load !== this.loading) {
      this.loading = decision.load;
      this.options.diagnostics?.record("adaptive_quality", {
        rendition: decision.load.id,
        estimateKbps: estimator.kbps === null ? null : Math.round(estimator.kbps),
      });
      this.options.onChange?.();
    }
    this.upgradeAfter = decision.keepSeconds;
  }

  /** Held pieces past this many seconds ahead are worth fetching again in a better quality. */
  private upgradeAfter = Number.POSITIVE_INFINITY;

  /** The next piece a lane should fetch, or null when it has all it needs. */
  private next(lane: Lane): number | null {
    for (const index of lane.waiting.keys()) if (!lane.held.has(index)) return index;
    const first = this.indexAt(this.positionSeconds);
    const last = Math.min(
      this.durations.length - 1,
      this.indexAt(this.positionSeconds + AHEAD_SECONDS),
    );
    for (let index = first; index <= last; index += 1) if (!lane.held.has(index)) return index;
    if (lane === this.audio) return null;
    const from = upgradeFrom({
      held: [...this.video.held].map(([index, piece]) => ({
        startSeconds: this.starts[index] ?? 0,
        rendition: piece.rendition ?? this.loading,
      })),
      renditions: this.options.renditions,
      load: this.loading,
      positionSeconds: this.positionSeconds,
      keepSeconds: this.choice === "auto" ? this.upgradeAfter : 2 * ADAPTIVE_PIECE_SECONDS,
    });
    if (from === null) return null;
    for (let index = this.indexAt(from); index <= last; index += 1) {
      const held = this.video.held.get(index);
      if (
        held?.rendition != null &&
        this.options.renditions.indexOf(held.rendition) >
          this.options.renditions.indexOf(this.loading)
      )
        return index;
    }
    return null;
  }

  private pumping = false;

  /** Keeps both lanes busy with the most useful piece each, one fetch per lane. */
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      this.decide();
      for (const lane of [this.video, this.audio]) {
        if (lane === this.audio && !this.hasAudio) continue;
        if (lane.fetching !== null) continue;
        const index = this.next(lane);
        if (index === null) continue;
        void this.fetchInto(lane, index);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async fetchInto(lane: Lane, index: number): Promise<void> {
    const controller = new AbortController();
    lane.fetching = { index, controller };
    const rendition = lane === this.video ? this.loading : null;
    const path = `${rendition?.id ?? "audio"}/${index}.ts`;
    try {
      for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
        try {
          const response = await (this.options.fetchImpl ?? fetch)(
            new URL(`${this.options.basePath}/${path}`, this.options.serverOrigin),
            {
              headers: { authorization: `Bearer ${this.options.bearer}` },
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            await response.body?.cancel().catch(ignoreFailure);
            throw new Error(`Piece request failed (HTTP ${response.status})`);
          }
          // Measured from the first byte: the server holds a piece until it is encoded.
          const firstByte = performance.now();
          const bytes = Buffer.from(await response.arrayBuffer());
          this.options.estimator.sample(
            bytes.length,
            performance.now() - firstByte,
            this.durations[index] ?? ADAPTIVE_PIECE_SECONDS,
          );
          if (this.closed) return;
          lane.held.set(index, { bytes, rendition });
          for (const wake of lane.waiting.get(index) ?? []) wake();
          this.options.onChange?.();
          return;
        } catch (cause) {
          if (controller.signal.aborted || this.closed) return;
          this.options.diagnostics?.record("adaptive_piece_failure", {
            piece: index,
            kind: lane.kind,
            attempt,
            message: cause instanceof Error ? cause.message : "unknown",
          });
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      // MPV gives up on a piece that will not come, which ends playback as an error.
      for (const wake of lane.waiting.get(index) ?? []) wake();
    } finally {
      if (lane.fetching?.controller === controller) lane.fetching = null;
      void this.pump();
    }
  }

  private async text(file: string): Promise<string> {
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(`${this.options.basePath}/${file}`, this.options.serverOrigin),
      { headers: { authorization: `Bearer ${this.options.bearer}` } },
    );
    if (!response.ok) throw new Error(`Server conversion is unavailable (HTTP ${response.status})`);
    return response.text();
  }
}
