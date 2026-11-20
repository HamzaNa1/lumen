/** How much one arrow press or scroll-wheel step moves the volume, on a 0–100 scale. */
export const VOLUME_STEP = 5;

const WHEEL_LINE_PIXELS = 40;
const WHEEL_PAGE_PIXELS = 120;
// Pixel travel needed for each additional step during a continuous scroll (such as a trackpad).
// Discrete mouse notches (typically 100–120 px) still emit one step per click.
const WHEEL_STEP_PIXELS = 50;
const WHEEL_IDLE_MS = 150;

export interface VolumeTarget {
  readonly volume: number;
  readonly muted: boolean;
}

export interface WheelSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly timeStamp: number;
}

export const stepVolume = (volume: number, delta: number): VolumeTarget => {
  const next = Math.max(0, Math.min(100, Math.round(volume + delta)));
  return { volume: next, muted: next === 0 };
};

export const toggleMute = (volume: number, muted: boolean): VolumeTarget =>
  muted || volume <= 0
    ? { volume: volume > 0 ? volume : VOLUME_STEP, muted: false }
    : { volume, muted: true };

/**
 * Turns wheel events into volume steps: -1 for down, 1 for up, and 0 while waiting for enough
 * travel on a smooth-scrolling trackpad.
 */
export const createWheelVolumeStepper = (): ((sample: WheelSample) => -1 | 0 | 1) => {
  let lastDirection: -1 | 0 | 1 = 0;
  let lastTime = -Infinity;
  let accumulated = 0;

  return ({ deltaX, deltaY, deltaMode, timeStamp }): -1 | 0 | 1 => {
    if (deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) return 0;
    const direction: -1 | 1 = deltaY < 0 ? 1 : -1;
    const scale = deltaMode === 1 ? WHEEL_LINE_PIXELS : deltaMode === 2 ? WHEEL_PAGE_PIXELS : 1;
    const magnitude = Math.abs(deltaY) * scale;

    if (
      lastDirection !== direction ||
      timeStamp < lastTime ||
      timeStamp - lastTime > WHEEL_IDLE_MS
    ) {
      lastDirection = direction;
      lastTime = timeStamp;
      accumulated = 0;
      return direction;
    }

    lastTime = timeStamp;
    accumulated += magnitude;
    if (accumulated >= WHEEL_STEP_PIXELS) {
      accumulated = 0;
      return direction;
    }
    return 0;
  };
};
