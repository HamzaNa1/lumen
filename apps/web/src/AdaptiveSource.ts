import {
  type AdaptiveDecision,
  decideAdaptive,
  type HeldPiece,
  type ThroughputEstimator,
  upgradeFrom,
} from "@lumen/client";
import { ADAPTIVE_PIECE_SECONDS, type AdaptiveRendition } from "@lumen/contracts";
import type HlsPlayer from "hls.js";
import type { ErrorData, FragBufferedData, FragLoadedData, LevelSwitchedData } from "hls.js";
import workerPath from "hls.js/dist/hls.worker.js?url";

/** Whether this browser can append converted pieces to a media element at all. */
export const adaptivePlaybackSupported = (): boolean => {
  const scope = globalThis as {
    MediaSource?: { isTypeSupported(type: string): boolean };
    ManagedMediaSource?: { isTypeSupported(type: string): boolean };
  };
  const source = scope.ManagedMediaSource ?? scope.MediaSource;
  return source?.isTypeSupported('video/mp4; codecs="avc1.4d4028,mp4a.40.2"') === true;
};

/** A manual choice keeps this much of what is held, then refetches the rest in the new quality. */
const MANUAL_KEEP_SECONDS = 2 * ADAPTIVE_PIECE_SECONDS;

/**
 * Plays the server's pieces through hls.js, with hls.js's own quality choice switched off:
 * `decideAdaptive` makes every choice, as the desktop's bridge does, and a step up replaces held
 * pieces past a margin instead of waiting for the buffer to play out.
 */
export class AdaptiveSource {
  private hls: HlsPlayer | null = null;
  private levelOf = new Map<string, number>();
  private renditionOfLevel = new Map<number, AdaptiveRendition>();
  private loading: AdaptiveRendition;
  private playing: AdaptiveRendition | null = null;
  private choice: string;
  private flushEvent: (typeof HlsPlayer.Events)["BUFFER_FLUSHING"] | null = null;
  /** The quality of each video piece in the buffer, by its start time. */
  private readonly held = new Map<number, HeldPiece>();

  constructor(
    private readonly element: HTMLMediaElement,
    private readonly options: {
      readonly url: string;
      readonly startSeconds: number;
      readonly renditions: ReadonlyArray<AdaptiveRendition>;
      readonly start: AdaptiveRendition;
      /** "auto" or a rendition id. */
      readonly choice: string;
      readonly estimator: ThroughputEstimator;
      readonly onChange: () => void;
      readonly onFatal: (cause: Error) => void;
    },
  ) {
    this.loading = options.start;
    this.choice = options.choice;
  }

  /** hls.js is loaded only by pages that play converted pieces. */
  static load(): Promise<typeof HlsPlayer> {
    return import("hls.js").then((module) => module.default);
  }

  attach(Hls: typeof HlsPlayer): void {
    const hls = new Hls({
      workerPath,
      startPosition: this.options.startSeconds,
      startLevel: -1,
      capLevelToPlayerSize: false,
      maxBufferLength: 90,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      // The server answers a piece once it is encoded; slow pieces are expected, not failures.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 45_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
        },
      },
    });
    this.hls = hls;
    this.flushEvent = Hls.Events.BUFFER_FLUSHING;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hls.levels.forEach((level, index) => {
        const url = Array.isArray(level.url) ? level.url[0] : level.url;
        const rendition = this.options.renditions.find((candidate) =>
          String(url).includes(`/${candidate.id}.m3u8`),
        );
        if (rendition === undefined) return;
        this.levelOf.set(rendition.id, index);
        this.renditionOfLevel.set(index, rendition);
      });
      const level = this.levelOf.get(this.loading.id);
      if (level !== undefined) {
        hls.startLevel = level;
        hls.loadLevel = level;
      }
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, data: FragLoadedData) => {
      const { loaded, loading } = data.frag.stats;
      // From first byte to last: the server holds a piece until it is encoded, and that wait
      // says nothing about the connection.
      this.options.estimator.sample(loaded, loading.end - loading.first, data.frag.duration);
      this.decide();
    });
    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data: FragBufferedData) => {
      const rendition = this.renditionOfLevel.get(data.frag.level);
      if (data.frag.type !== "main" || rendition === undefined) return;
      const startSeconds = Math.round(data.frag.start * 1000) / 1000;
      this.held.set(startSeconds, { startSeconds, rendition });
      this.decide();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data: LevelSwitchedData) => {
      this.playing = this.renditionOfLevel.get(data.level) ?? this.playing;
      this.options.onChange();
    });
    hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else this.options.onFatal(new Error("The connection was lost while loading this file."));
    });
    hls.attachMedia(this.element);
    hls.loadSource(this.options.url);
  }

  get playingRendition(): AdaptiveRendition | null {
    return this.playing;
  }

  get loadingRendition(): AdaptiveRendition {
    return this.loading;
  }

  /** Re-evaluates the quality of the next pieces; called as pieces arrive and as time passes. */
  decide(): void {
    if (this.choice !== "auto") return;
    this.apply(
      decideAdaptive({
        renditions: this.options.renditions,
        loading: this.loading,
        estimateKbps: this.options.estimator.kbps,
        bufferAheadSeconds: this.bufferAhead(),
        secondsSinceSample:
          this.options.estimator.sampledAtMs === null
            ? Number.POSITIVE_INFINITY
            : (Date.now() - this.options.estimator.sampledAtMs) / 1000,
      }),
    );
  }

  /** "auto" or a rendition id. A manual choice shows within a couple of pieces. */
  choose(choice: string): void {
    this.choice = choice;
    if (choice === "auto") {
      this.decide();
      return;
    }
    const rendition = this.options.renditions.find((candidate) => candidate.id === choice);
    if (rendition === undefined || rendition === this.loading) return;
    this.apply({ load: rendition, keepSeconds: MANUAL_KEEP_SECONDS });
  }

  destroy(): void {
    this.hls?.destroy();
    this.hls = null;
  }

  private apply(decision: AdaptiveDecision): void {
    const hls = this.hls;
    const level = this.levelOf.get(decision.load.id);
    if (hls === null || level === undefined) return;
    if (decision.load !== this.loading) {
      this.loading = decision.load;
      hls.loadLevel = level;
      this.options.onChange();
    }
    const from = upgradeFrom({
      held: this.held.values(),
      renditions: this.options.renditions,
      load: decision.load,
      positionSeconds: this.element.currentTime,
      keepSeconds: decision.keepSeconds,
    });
    if (from === null || this.flushEvent === null) return;
    for (const start of [...this.held.keys()]) if (start >= from) this.held.delete(start);
    hls.trigger(this.flushEvent, {
      startOffset: from,
      endOffset: Number.POSITIVE_INFINITY,
      type: hls.audioTracks.length > 0 ? "video" : null,
    });
  }

  private bufferAhead(): number {
    const { buffered, currentTime } = this.element;
    for (let index = 0; index < buffered.length; index += 1)
      if (buffered.start(index) <= currentTime + 0.25 && buffered.end(index) > currentTime)
        return buffered.end(index) - currentTime;
    return 0;
  }
}
