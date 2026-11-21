import {
  ADAPTIVE_AUDIO_KBPS,
  ADAPTIVE_PIECE_SECONDS,
  type AdaptiveRendition,
  DEFAULT_QUALITY,
  type PlayerQuality,
  type QualityOption,
  type TrackMemory,
} from "@lumen/contracts";

/**
 * Measures the connection from finished downloads. Two averages, as hls.js and Shaka keep: the
 * fast one notices a drop within a couple of pieces, the slow one keeps one quick download from
 * looking like headroom. The lower of the two is the estimate. Samples weigh by the seconds of
 * media they carried, so a fast link moves the estimate as quickly as a slow one does.
 */
export class ThroughputEstimator {
  private fast: number | null;
  private slow: number | null;
  /** When the last download said something about the link. */
  sampledAtMs: number | null = null;

  constructor(initialKbps: number | null = null) {
    this.fast = initialKbps;
    this.slow = initialKbps;
  }

  /** Ignores transfers too small or quick to say anything about the link. */
  sample(bytes: number, milliseconds: number, mediaSeconds: number, nowMs = Date.now()): void {
    if (bytes < 16_000 || mediaSeconds <= 0) return;
    this.sampledAtMs = nowMs;
    // A transfer finished within the clock's resolution only says the link is very fast.
    const kbps = (bytes * 8) / Math.max(1, milliseconds);
    const blend = (current: number | null, halfLifeSeconds: number) => {
      if (current === null) return kbps;
      const weight = 0.5 ** (mediaSeconds / halfLifeSeconds);
      return current * weight + kbps * (1 - weight);
    };
    this.fast = blend(this.fast, 6);
    this.slow = blend(this.slow, 20);
  }

  /** What a stall proves: the link carried less than playback needed. */
  capAt(kbps: number): void {
    if (this.fast === null || kbps < this.fast) this.fast = kbps;
    if (this.slow === null || kbps < this.slow) this.slow = kbps;
  }

  get kbps(): number | null {
    if (this.fast === null || this.slow === null) return null;
    return Math.min(this.fast, this.slow);
  }
}

/** Climb only with clear headroom; leave a quality only once it clearly no longer fits. */
const UP_HEADROOM = 0.7;
const KEEP_HEADROOM = 0.9;
/** Below this much buffer the next piece must arrive quickly, whatever it looks like. */
const LOW_BUFFER_SECONDS = 8;
const LOW_BUFFER_HEADROOM = 0.5;
/** What an encoder restart on the server costs before a better piece can arrive. */
const RESTART_SECONDS = 2;
/**
 * A full buffer fetches nothing, so nothing measures the link. After this long without a
 * measurement, Auto fetches the next pieces one quality up: real content that doubles as a probe.
 */
const PROBE_AFTER_SECONDS = 12;

const needs = (rendition: AdaptiveRendition) => rendition.maxKbps + ADAPTIVE_AUDIO_KBPS;

const bestWithin = (
  renditions: ReadonlyArray<AdaptiveRendition>,
  kbps: number,
): AdaptiveRendition | undefined =>
  renditions.find((rendition) => needs(rendition) <= kbps) ?? renditions.at(-1);

export interface AdaptiveState {
  /** Best first. */
  readonly renditions: ReadonlyArray<AdaptiveRendition>;
  /** The quality new pieces are fetched in. */
  readonly loading: AdaptiveRendition;
  readonly estimateKbps: number | null;
  /** Contiguous seconds held ahead of the playhead. */
  readonly bufferAheadSeconds: number;
  /** Seconds since the link was last measured; infinite when it never was. */
  readonly secondsSinceSample: number;
}

export interface AdaptiveDecision {
  readonly load: AdaptiveRendition;
  /**
   * How far ahead of the playhead held pieces must stay as they are: fetching a better one must
   * finish before playback gets there. Infinite when nothing should be refetched.
   */
  readonly keepSeconds: number;
}

/**
 * Chooses the quality of the next pieces. A step down keeps every piece already held, so the
 * picture only softens; pieces held past `keepSeconds` that are worse than `load` are fetched
 * again (see `upgradeFrom`), so a step up reaches the screen in seconds rather than after the
 * buffer has played out.
 */
export const decideAdaptive = (state: AdaptiveState): AdaptiveDecision => {
  const { renditions, loading, estimateKbps, bufferAheadSeconds } = state;
  if (estimateKbps === null) return { load: loading, keepSeconds: Number.POSITIVE_INFINITY };
  const index = renditions.indexOf(loading);
  const keepFor = (target: AdaptiveRendition) =>
    Math.max(
      2 * ADAPTIVE_PIECE_SECONDS,
      RESTART_SECONDS + (ADAPTIVE_PIECE_SECONDS * needs(target)) / estimateKbps + 2,
    );
  if (bufferAheadSeconds < LOW_BUFFER_SECONDS) {
    const safe = bestWithin(renditions, estimateKbps * LOW_BUFFER_HEADROOM) ?? loading;
    return {
      load: renditions.indexOf(safe) > index ? safe : loading,
      keepSeconds: Number.POSITIVE_INFINITY,
    };
  }
  // An old estimate is not news: a probe stands until its own piece has been measured.
  const fresh = state.secondsSinceSample < PROBE_AFTER_SECONDS;
  if (fresh && needs(loading) > estimateKbps * KEEP_HEADROOM) {
    const lower = bestWithin(renditions, estimateKbps * KEEP_HEADROOM) ?? loading;
    return { load: lower, keepSeconds: Number.POSITIVE_INFINITY };
  }
  const better = bestWithin(renditions, estimateKbps * UP_HEADROOM);
  if (better !== undefined && renditions.indexOf(better) < index)
    return { load: better, keepSeconds: keepFor(better) };
  const probe = renditions[index - 1];
  if (probe !== undefined && !fresh) return { load: probe, keepSeconds: keepFor(probe) };
  return { load: loading, keepSeconds: keepFor(loading) };
};

export interface HeldPiece {
  /** Where the piece starts on the media timeline. */
  readonly startSeconds: number;
  readonly rendition: AdaptiveRendition;
}

/**
 * Where to start fetching held pieces again: the first one past the kept stretch that is worse
 * than what now loads. Null when everything held there is already as good.
 */
export const upgradeFrom = (options: {
  readonly held: Iterable<HeldPiece>;
  readonly renditions: ReadonlyArray<AdaptiveRendition>;
  readonly load: AdaptiveRendition;
  readonly positionSeconds: number;
  readonly keepSeconds: number;
}): number | null => {
  const target = options.renditions.indexOf(options.load);
  let from: number | null = null;
  for (const piece of options.held)
    if (
      piece.startSeconds >= options.positionSeconds + options.keepSeconds &&
      options.renditions.indexOf(piece.rendition) > target &&
      (from === null || piece.startSeconds < from)
    )
      from = piece.startSeconds;
  return from;
};

/** Where to start when nothing has been measured: a middle quality that most links carry. */
export const startingRendition = (
  renditions: ReadonlyArray<AdaptiveRendition>,
  estimateKbps: number | null,
): AdaptiveRendition | undefined =>
  estimateKbps === null
    ? (renditions.find((rendition) => rendition.height <= 720) ?? renditions.at(-1))
    : bestWithin(renditions, estimateKbps * UP_HEADROOM);

/** The original file's average bitrate, which is what playing it needs on average. */
export const originalKbps = (
  sizeBytes: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null =>
  sizeBytes == null || durationSeconds == null || durationSeconds <= 0
    ? null
    : Math.round((sizeBytes * 8) / durationSeconds / 1000);

/** The quality menu for a player that can play the original and, when offered, renditions. */
export const qualityState = (options: {
  readonly choice: string;
  readonly playing: string;
  readonly original: { readonly height: number | null; readonly kbps: number | null } | null;
  readonly renditions: ReadonlyArray<AdaptiveRendition>;
  readonly measuredKbps: number | null;
}): PlayerQuality => ({
  choice: options.choice,
  playing: options.playing,
  options: [
    ...(options.original === null
      ? []
      : [{ id: "original", height: options.original.height, kbps: options.original.kbps }]),
    ...options.renditions.map(
      (rendition): QualityOption => ({
        id: rendition.id,
        height: rendition.height,
        kbps: needs(rendition),
      }),
    ),
  ],
  measuredKbps: options.measuredKbps === null ? null : Math.round(options.measuredKbps),
});

/** The quality a title starts in: the viewer's choice for it, else their setting. */
export const rememberedQuality = (memory: TrackMemory | undefined): string =>
  memory?.quality ?? memory?.preferences.quality ?? DEFAULT_QUALITY;

/**
 * What a remembered quality plays for one file. A height the file is not converted to plays the
 * best one below it, and the original plays Auto where it cannot play.
 */
export const resolveQualityChoice = (
  preference: string,
  renditions: ReadonlyArray<{ readonly id: string; readonly height: number | null }>,
  originalUsable: boolean,
): string => {
  if (renditions.length === 0) return originalUsable ? "original" : "auto";
  if (preference === "auto") return "auto";
  if (preference === "original") return originalUsable ? "original" : "auto";
  const height = Number.parseInt(preference, 10);
  const rendition =
    renditions.find((candidate) => candidate.id === preference) ??
    renditions.find((candidate) => candidate.height !== null && candidate.height <= height) ??
    renditions.at(-1);
  return rendition?.id ?? "auto";
};

/** The last measurement per server, so the next playback starts at a sensible quality. */
const remembered = new Map<string, number>();
export const rememberedThroughput = (server: string): number | null =>
  remembered.get(server) ?? null;
export const rememberThroughput = (server: string, kbps: number | null): void => {
  if (kbps !== null) remembered.set(server, kbps);
};
