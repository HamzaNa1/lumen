/**
 * When Auto moves between the original file and the converted qualities. Moving either way
 * replaces the stream, so it happens only when the evidence is strong. Returning to the original
 * is optional: `RETURN_TO_ORIGINAL` turns it off, leaving the move out of it one-way.
 */
export const RETURN_TO_ORIGINAL = true;

/** The original's bitrate varies scene to scene, so its average needs a wide margin. */
const ORIGINAL_HEADROOM = 1.5;
/** Leaving the original starts before the buffer runs out, while the switch can still hide. */
const LEAVE_BELOW_SECONDS = 12;
/** How long the link must keep proving headroom before a mid-play return. */
export const RETURN_AFTER_SECONDS = 30;

/** Whether the original is the right start, or the right landing for a seek. */
export const originalFits = (estimateKbps: number | null, originalKbps: number | null): boolean =>
  originalKbps !== null &&
  (estimateKbps === null || estimateKbps >= originalKbps * ORIGINAL_HEADROOM);

/** Whether Auto should give up the original for the converted qualities. */
export const shouldLeaveOriginal = (state: {
  readonly stalled: boolean;
  readonly bufferAheadSeconds: number;
  readonly estimateKbps: number | null;
  readonly originalKbps: number | null;
}): boolean =>
  state.stalled ||
  (state.bufferAheadSeconds < LEAVE_BELOW_SECONDS &&
    state.estimateKbps !== null &&
    state.originalKbps !== null &&
    state.estimateKbps < state.originalKbps * 1.1);

/**
 * Tracks how long the link has carried the original with room to spare, so a return mid-play
 * needs sustained proof rather than one fast download.
 */
export class OriginalReturn {
  private since: number | null = null;

  /** True once the original has fit for `RETURN_AFTER_SECONDS` straight. */
  observe(nowMs: number, estimateKbps: number | null, originalKbps: number | null): boolean {
    if (!RETURN_TO_ORIGINAL || estimateKbps === null || !originalFits(estimateKbps, originalKbps)) {
      this.since = null;
      return false;
    }
    this.since ??= nowMs;
    return nowMs - this.since >= RETURN_AFTER_SECONDS * 1000;
  }

  reset(): void {
    this.since = null;
  }
}
