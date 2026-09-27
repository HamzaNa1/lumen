export type GroupDiagnostic = (event: string, fields: Record<string, string | number>) => void;

export class GroupDiagnostics {
  private samples = 0;
  private withinTolerance = 0;
  private moderateDrift = 0;
  private largeDrift = 0;
  private hardSeeks = 0;
  private rateChanges = 0;
  private maxDriftMs = 0;
  private lastReport = 0;
  constructor(private readonly report: GroupDiagnostic = () => {}) {}
  sample(driftMs: number, now: number): void {
    this.samples++;
    const drift = Math.abs(driftMs);
    if (drift <= 120) this.withinTolerance++;
    else if (drift < 1_000) this.moderateDrift++;
    else this.largeDrift++;
    this.maxDriftMs = Math.max(this.maxDriftMs, drift);
    if (now - this.lastReport >= 30_000) this.flush(now);
  }
  correction(type: "seek" | "rate"): void {
    if (type === "seek") this.hardSeeks++;
    else this.rateChanges++;
  }
  failure(attempt: number): void {
    this.report("watch_group_player_failure", { attempt });
  }
  flush(now: number): void {
    if (this.samples + this.hardSeeks + this.rateChanges > 0)
      this.report("watch_group_sync", {
        samples: this.samples,
        driftWithin120Ms: this.withinTolerance,
        driftBelow1000Ms: this.moderateDrift,
        driftAtLeast1000Ms: this.largeDrift,
        maxDriftMs: Math.round(this.maxDriftMs),
        hardSeeks: this.hardSeeks,
        rateChanges: this.rateChanges,
      });
    this.samples = this.withinTolerance = this.moderateDrift = this.largeDrift = 0;
    this.hardSeeks = this.rateChanges = this.maxDriftMs = 0;
    this.lastReport = now;
  }
}
