import { Schema } from "effect";

/**
 * Converted video is cut into pieces of this length at the same source times in every quality,
 * so a player can follow piece n of one quality with piece n + 1 of another.
 */
export const ADAPTIVE_PIECE_SECONDS = 4;
export const ADAPTIVE_AUDIO_KBPS = 192;

export interface AdaptiveRendition {
  readonly id: string;
  readonly height: number;
  /** The encoder never exceeds this over its rate-control buffer. */
  readonly maxKbps: number;
}

const LADDER: ReadonlyArray<AdaptiveRendition> = [
  { id: "1080p", height: 1080, maxKbps: 8000 },
  { id: "720p", height: 720, maxKbps: 4000 },
  { id: "480p", height: 480, maxKbps: 1500 },
  { id: "360p", height: 360, maxKbps: 800 },
];

/** The qualities offered for a source, best first; never larger than the source itself. */
export const adaptiveRenditionsFor = (
  sourceHeight: number | null,
): ReadonlyArray<AdaptiveRendition> => {
  if (sourceHeight === null) return LADDER;
  const fitting = LADDER.filter((rendition) => rendition.height <= sourceHeight);
  return fitting.length > 0 ? fitting : LADDER.slice(-1);
};

export const adaptiveRendition = (id: string): AdaptiveRendition | null =>
  LADDER.find((rendition) => rendition.id === id) ?? null;

export const adaptivePieceCount = (durationSeconds: number): number =>
  Math.max(1, Math.ceil(durationSeconds / ADAPTIVE_PIECE_SECONDS));

/** How long piece `index` lasts; every piece is full length except possibly the last. */
export const adaptivePieceSeconds = (durationSeconds: number, index: number): number =>
  Math.max(
    0.001,
    Math.min(ADAPTIVE_PIECE_SECONDS, durationSeconds - index * ADAPTIVE_PIECE_SECONDS),
  );

/** "auto", "original", or a rendition id. */
export const QualityChoice = Schema.String.check(Schema.isMinLength(1));
export type QualityChoice = Schema.Schema.Type<typeof QualityChoice>;

export const QualityOption = Schema.Struct({
  /** "original" or a rendition id. */
  id: Schema.String,
  height: Schema.NullOr(Schema.Number),
  /** What the option needs from the connection; null where unknown. */
  kbps: Schema.NullOr(Schema.Number),
});
export type QualityOption = Schema.Schema.Type<typeof QualityOption>;

export const PlayerQuality = Schema.Struct({
  choice: QualityChoice,
  /** What is on screen now: "original" or a rendition id. */
  playing: Schema.String,
  /** Best first. A single option means the viewer has nothing to choose. */
  options: Schema.Array(QualityOption),
  /** The connection as measured, in kilobits per second; null until measured. */
  measuredKbps: Schema.NullOr(Schema.Number),
});
export type PlayerQuality = Schema.Schema.Type<typeof PlayerQuality>;
