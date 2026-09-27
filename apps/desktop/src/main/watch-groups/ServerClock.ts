interface ClockSample {
  readonly offset: number;
  readonly rtt: number;
  readonly at: number;
}
export class ServerClock {
  private readonly pending = new Map<string, number>();
  private samples: ClockSample[] = [];
  reset(): void {
    this.pending.clear();
    this.samples = [];
  }
  begin(id: string, now: number): void {
    for (const [key, at] of this.pending) if (now - at > 5_000) this.pending.delete(key);
    if (this.pending.size >= 16) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(id, now);
  }
  receive(id: string, t1: number, t2: number, t3: number): boolean {
    const t0 = this.pending.get(id);
    this.pending.delete(id);
    if (
      t0 === undefined ||
      ![t0, t1, t2, t3].every(Number.isFinite) ||
      t0 < 0 ||
      t1 < 0 ||
      t2 < t1 ||
      t3 < t0 ||
      t3 - t0 > 5_000
    )
      return false;
    const rtt = t3 - t0 - (t2 - t1);
    if (rtt < 0) return false;
    this.samples = [
      ...this.samples.filter((s) => t3 - s.at <= 15_000),
      { offset: (t1 - t0 + (t2 - t3)) / 2, rtt, at: t3 },
    ].slice(-12);
    return true;
  }
  estimate(now: number): { serverNowMs: number; uncertaintyMs: number; fine: boolean } | null {
    if (this.samples.length < 3) return null;
    const fresh = this.samples.filter((s) => now - s.at <= 15_000);
    const best = [...(fresh.length >= 3 ? fresh : this.samples)].sort((a, b) => a.rtt - b.rtt)[0];
    if (best === undefined) return null;
    return {
      serverNowMs: Math.max(0, now + best.offset),
      uncertaintyMs: best.rtt / 2,
      fine: fresh.length >= 3 && best.rtt <= 400,
    };
  }
}
