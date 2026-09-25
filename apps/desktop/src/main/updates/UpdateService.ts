import type { IpcUpdateState } from "@lumen/contracts";

export interface UpdateAdapter {
  check(): Promise<{ readonly version: string; readonly downloadPromise?: Promise<unknown> } | null>;
  onProgress(listener: (percent: number) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
}

export interface UpdateClock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: UpdateClock = {
  now: Date.now,
  random: Math.random,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
const REGULAR_MS = 6 * 60 * 60 * 1_000;
const READY_MESSAGE = "Update ready. It will be available the next time you start Lumen.";

const newerStableVersion = (candidate: string, current: string): boolean => {
  const parse = (version: string): number[] | null =>
    /^\d+\.\d+\.\d+$/u.test(version) ? version.split(".").map(Number) : null;
  const next = parse(candidate);
  const installed = parse(current);
  if (next === null || installed === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] ?? 0) > (installed[index] ?? 0)) return true;
    if ((next[index] ?? 0) < (installed[index] ?? 0)) return false;
  }
  return false;
};

export class UpdateService {
  private state: IpcUpdateState;
  private readonly clock: UpdateClock;
  private readonly listeners = new Set<(state: IpcUpdateState) => void>();
  private readonly unsubscribeProgress: () => void;
  private readonly unsubscribeError: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private started = false;
  private failures = 0;
  private errorGeneration = 0;
  private nextCheckAtMs = 0;
  private lastProgressAtMs = 0;

  constructor(private readonly options: {
    readonly adapter: UpdateAdapter;
    readonly currentVersion: string;
    readonly eligible: boolean;
    readonly unsupportedReason?: string;
    readonly clock?: UpdateClock;
  }) {
    this.clock = options.clock ?? systemClock;
    this.state = {
      revision: 0,
      currentVersion: options.currentVersion,
      phase: options.eligible ? "idle" : "unsupported",
      availableVersion: null,
      progressPercent: null,
      lastCheckedAtMs: null,
      message: options.eligible ? null : (options.unsupportedReason ?? "Automatic updates are unavailable for this package."),
    };
    this.unsubscribeProgress = options.adapter.onProgress((percent) => this.progress(percent));
    this.unsubscribeError = options.adapter.onError((error) => this.fail(error));
  }

  snapshot(): IpcUpdateState { return this.state; }

  subscribe(listener: (state: IpcUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.stopping || !this.options.eligible) return;
    this.started = true;
    this.schedule(15_000);
  }

  resume(): void {
    if (this.stopping || !this.started || this.state.phase === "ready" || this.inFlight !== null) return;
    if (this.clock.now() >= this.nextCheckAtMs) {
      if (this.timer !== null) this.clock.clearTimeout(this.timer);
      this.timer = null;
      void this.checkNow();
    }
  }

  checkNow(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (!this.options.eligible || this.stopping || this.state.phase === "ready") return Promise.resolve();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.setState({ phase: "checking", availableVersion: null, progressPercent: null, message: null });
    const errorGeneration = this.errorGeneration;
    const operation = (async () => {
      try {
        const result = await this.options.adapter.check();
        if (this.stopping || this.errorGeneration !== errorGeneration) return;
        this.setState({ lastCheckedAtMs: this.clock.now() });
        if (result?.downloadPromise === undefined ||
            !newerStableVersion(result.version, this.options.currentVersion)) {
          this.failures = 0;
          this.setState({ phase: "idle", availableVersion: null, progressPercent: null });
          return;
        }
        this.setState({ phase: "downloading", availableVersion: result.version });
        await result.downloadPromise;
        if (this.stopping || this.errorGeneration !== errorGeneration) return;
        this.failures = 0;
        this.setState({ phase: "ready", progressPercent: 100, message: READY_MESSAGE });
      } catch (error) {
        this.fail(error);
      }
    })().finally(() => {
      this.inFlight = null;
      if (!this.stopping && this.state.phase !== "ready") {
        const delay = this.state.phase === "error"
          ? (RETRY_MS[Math.min(Math.max(this.failures - 1, 0), RETRY_MS.length - 1)] ?? 3_600_000)
          : Math.round(REGULAR_MS * (0.95 + this.clock.random() * 0.1));
        this.schedule(delay);
      }
    });
    this.inFlight = operation;
    return operation;
  }

  suspend(): void {
    this.stopping = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.suspend();
    this.listeners.clear();
    this.unsubscribeProgress();
    this.unsubscribeError();
  }

  private progress(percent: number): void {
    if (this.stopping || this.state.phase !== "downloading" || !Number.isFinite(percent)) return;
    const now = this.clock.now();
    if (now - this.lastProgressAtMs < 250 && percent < 100) return;
    this.lastProgressAtMs = now;
    this.setState({ progressPercent: Math.max(0, Math.min(100, percent)) });
  }

  private fail(error: unknown): void {
    if (this.stopping || this.state.phase === "ready" || this.state.phase === "error") return;
    this.failures += 1;
    this.errorGeneration += 1;
    const code = typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : "UPDATE_FAILED";
    console.warn("desktop update failed", { currentVersion: this.options.currentVersion, platform: process.platform, phase: this.state.phase, code });
    this.setState({ phase: "error", progressPercent: null, message: "Could not check or download the update. Lumen will retry automatically." });
    if (this.inFlight === null && this.started) {
      if (this.timer !== null) this.clock.clearTimeout(this.timer);
      this.schedule(RETRY_MS[0]);
    }
  }

  private schedule(delayMs: number): void {
    this.nextCheckAtMs = this.clock.now() + delayMs;
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.checkNow(); }, delayMs);
    this.timer.unref?.();
  }

  private setState(change: Partial<IpcUpdateState>): void {
    if (this.stopping) return;
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
}
