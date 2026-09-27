export const defaultWatchGroupLimits = {
  groups: 100,
  members: 32,
  frameBytes: 16_384,
  queue: 64,
  backpressureBytes: 262_144,
  controlsPerSecond: 10,
  controlBurst: 20,
  roomControlsPerSecond: 100,
  roomControlBurst: 200,
  framesPerSecond: 25,
  frameBurst: 50,
  tickets: 1_024,
  unauthenticatedSockets: 128,
  passwordOperations: 2,
  joinAttemptsPerMinute: 10,
  rateKeys: 4_096,
  resultsPerMember: 256,
  resultTtlMs: 120_000,
  reconnectGraceMs: 30_000,
  emptyExpiryMs: 300_000,
  ticketTtlMs: 30_000,
  authenticationTimeoutMs: 5_000,
  validationTimeoutMs: 2_000,
  refreshMs: 5_000,
} as const;
export type WatchGroupLimits = { readonly [K in keyof typeof defaultWatchGroupLimits]: number };

export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(
      this.burst,
      this.tokens + (Math.max(0, now - this.at) * this.perSecond) / 1_000,
    );
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
