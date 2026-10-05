export const RECOVERY_DEADLINE_MS = 30_000;
export const MAX_DELIVERY_RETRIES = 3;

/** Shared by every managed loader in one playback attempt, including grant reconciliation. */
export class DeliveryRecovery {
  private deadline = Number.POSITIVE_INFINITY;
  private attempts = 0;
  private successfulSince: number | null = null;
  private lastPosition: number | null = null;

  remaining(nowMs = Date.now()): number {
    return this.deadline - nowMs;
  }

  retry(nowMs = Date.now(), requestStartedAtMs = nowMs): number | null {
    this.successfulSince = null;
    this.lastPosition = null;
    if (this.deadline === Number.POSITIVE_INFINITY)
      this.deadline = requestStartedAtMs + RECOVERY_DEADLINE_MS;
    if (this.attempts >= MAX_DELIVERY_RETRIES || nowMs >= this.deadline) return null;
    this.attempts += 1;
    return this.attempts;
  }

  observe(position: number, playing: boolean, nowMs = Date.now()): void {
    if (!playing || (this.lastPosition !== null && position <= this.lastPosition))
      this.successfulSince = null;
    else if (this.lastPosition !== null && position > this.lastPosition) {
      this.successfulSince ??= nowMs;
      if (nowMs - this.successfulSince >= RECOVERY_DEADLINE_MS) {
        this.attempts = 0;
        this.deadline = Number.POSITIVE_INFINITY;
      }
    }
    this.lastPosition = position;
  }
}

export const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Playback cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
