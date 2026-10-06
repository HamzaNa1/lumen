import type { PlayerState } from "@lumen/contracts";

export type WatchPlayerState = Pick<
  PlayerState,
  "sessionId" | "itemId" | "positionSeconds" | "durationSeconds" | "paused"
>;

/** A fresh position and motion state, measured on the local performance.now() clock. */
export interface WatchPlaybackSample extends WatchPlayerState {
  readonly sampledAtMs: number;
  readonly speed: number;
  /** False during pause, seek, starvation, end of file, or suspension. */
  readonly advancing: boolean;
}

export const watchSamplePosition = (sample: WatchPlaybackSample, nowMs: number): number | null => {
  const ageMs = nowMs - sample.sampledAtMs;
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > 250 ||
    !Number.isFinite(sample.positionSeconds) ||
    sample.positionSeconds < 0 ||
    !Number.isFinite(sample.speed) ||
    sample.speed < 0.9 ||
    sample.speed > 1.1
  )
    return null;
  return Math.min(
    sample.positionSeconds +
      (sample.advancing && !sample.paused ? (ageMs * sample.speed) / 1000 : 0),
    sample.durationSeconds ?? Infinity,
  );
};

export interface WatchCorrection {
  readonly seek: number | null;
  readonly speed: number;
}

const ENTER_SECONDS = 0.15;
const EXIT_SECONDS = 0.05;
const SUSTAIN_MS = 1500;
const MAX_SAMPLE_GAP_MS = 1500;
const MAX_ADJUSTMENT = 0.01;
// A 250 ms drift reaches the cap; nearer the exit threshold it settles more gently.
const PROPORTIONAL_GAIN = 0.04;

/** Hysteresis and elapsed-time persistence shared by every watch-group player. */
export class WatchDriftCorrection {
  private direction = 0;
  private sinceMs = 0;
  private lastMs: number | null = null;
  private adjusting = false;

  reset(): void {
    this.direction = 0;
    this.lastMs = null;
    this.adjusting = false;
  }

  update(
    positionSeconds: number,
    targetSeconds: number,
    paused: boolean,
    nowMs: number,
  ): WatchCorrection {
    const drift = targetSeconds - positionSeconds;
    const magnitude = Math.abs(drift);
    if (magnitude >= 1 || (paused && magnitude > 0.08)) {
      this.reset();
      return { seek: targetSeconds, speed: 1 };
    }
    if (paused || magnitude <= EXIT_SECONDS) {
      this.reset();
      return { seek: null, speed: 1 };
    }
    if (this.lastMs !== null && (nowMs < this.lastMs || nowMs - this.lastMs > MAX_SAMPLE_GAP_MS))
      this.reset();
    this.lastMs = nowMs;
    const direction = Math.sign(drift);
    if (direction !== this.direction) {
      this.direction = 0;
      this.adjusting = false;
    }
    if (!this.adjusting) {
      if (magnitude < ENTER_SECONDS) {
        this.direction = 0;
        return { seek: null, speed: 1 };
      }
      if (this.direction === 0) {
        this.direction = direction;
        this.sinceMs = nowMs;
      }
      if (nowMs - this.sinceMs < SUSTAIN_MS) return { seek: null, speed: 1 };
      this.adjusting = true;
    }
    // Quantization avoids sending imperceptible speed changes on every sample.
    const adjustment =
      Math.round(Math.min(MAX_ADJUSTMENT, magnitude * PROPORTIONAL_GAIN) * 1000) / 1000;
    return { seek: null, speed: 1 + direction * adjustment };
  }
}
