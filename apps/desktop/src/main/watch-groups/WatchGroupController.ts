import {
  playbackRevision,
  positionAt,
  snapshotPlaybackId,
  type GroupSnapshot,
  type IpcPlayerSession,
  type IpcWatchGroupState,
} from "@lumen/contracts";
import type { GroupPlayer } from "./GroupPlayer";
import { chooseCorrection } from "./SyncPolicy";
export interface GroupControllerOptions {
  readonly player: GroupPlayer;
  readonly acquire: (playbackId: string, signal: AbortSignal) => Promise<IpcPlayerSession>;
  readonly release: (session: IpcPlayerSession) => Promise<void>;
  readonly clock: (
    now: number,
  ) => { serverNowMs: number; uncertaintyMs: number; fine: boolean } | null;
  readonly now: () => number;
  readonly onStatus: (status: IpcWatchGroupState["status"], error: string | null) => void;
}
export class WatchGroupController {
  private latest: GroupSnapshot | null = null;
  private connected = false;
  private disposed = false;
  private requested = false;
  private worker: Promise<void> | null = null;
  private operation = new AbortController();
  private loadedId: string | null = null;
  private alignment = -1;
  private terminalAlignment: number | null = null;
  private paused = true;
  private rate = 1;
  private lastSeek = -Infinity;
  private failures = 0;
  private reloadRequested = false;
  private retryAt = 0;
  constructor(private readonly options: GroupControllerOptions) {}
  update(snapshot: GroupSnapshot): void {
    if (this.disposed) return;
    if (
      this.latest !== null &&
      (snapshot.serverInstanceId !== this.latest.serverInstanceId ||
        snapshot.groupId !== this.latest.groupId ||
        playbackRevision(snapshot) < playbackRevision(this.latest))
    )
      return;
    const identityChanged =
      this.latest === null ||
      snapshotPlaybackId(snapshot) !== snapshotPlaybackId(this.latest) ||
      snapshot.playback.type !== this.latest.playback.type;
    this.latest = snapshot;
    if (identityChanged) {
      this.operation.abort();
      this.operation = new AbortController();
      this.failures = 0;
      this.retryAt = 0;
    }
    this.requested = true;
    void this.tick();
  }
  setConnected(connected: boolean): void {
    if (connected && !this.connected) this.alignment = -1;
    this.connected = connected;
    if (!connected) {
      this.operation.abort();
      this.operation = new AbortController();
    }
    this.requested = true;
    void this.tick();
  }
  renewSession(): void {
    this.operation.abort();
    this.operation = new AbortController();
    this.reloadRequested = true;
    this.requested = true;
    void this.tick();
  }
  retry(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.requested = true;
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requested = true;
    if (this.worker !== null) return this.worker;
    const work = this.reconcile();
    this.worker = work;
    void work.finally(() => {
      if (this.worker === work) this.worker = null;
    });
    return work;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.operation.abort();
    await this.worker;
    await this.options.player.setPlaybackRate(1).catch(() => undefined);
    await this.options.player.stopLocal();
  }
  private async reconcile(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false;
      const signal = this.operation.signal;
      try {
        await this.apply(signal);
      } catch {
        if (signal.aborted || this.disposed) continue;
        this.failures++;
        this.retryAt = this.options.now() + Math.min(5_000, 500 * 2 ** this.failures);
        await this.setRate(1).catch(() => undefined);
        await this.setPaused(true).catch(() => undefined);
        this.options.onStatus(
          "failed",
          this.failures >= 3
            ? "Playback could not synchronize. Retry or leave the group."
            : "Playback interrupted. Retrying synchronization…",
        );
      }
    }
  }
  private async apply(signal: AbortSignal): Promise<void> {
    const snapshot = this.latest;
    if (snapshot === null) return;
    if (
      snapshot.playback.type === "playback-access-denied" ||
      (snapshot.playback.type === "playback" && snapshot.playback.state.mode === "stopped")
    ) {
      await this.stop();
      this.options.onStatus(
        snapshot.playback.type === "playback-access-denied" ? "blocked" : "ready",
        null,
      );
      return;
    }
    if (!this.connected || this.options.clock(this.options.now()) === null) {
      await this.setRate(1);
      await this.setPaused(true);
      return;
    }
    if (this.failures >= 3 || this.options.now() < this.retryAt) return;
    const state = snapshot.playback.state;
    if (state.mode === "ended") {
      await this.setRate(1);
      await this.setPaused(true);
      if (this.loadedId !== state.playbackId) await this.stop();
      this.options.onStatus("ready", null);
      return;
    }
    if (this.loadedId !== state.playbackId || this.reloadRequested) {
      this.options.onStatus("synchronizing", null);
      await this.stop();
      signal.throwIfAborted();
      const session = await this.options.acquire(state.playbackId, signal);
      if (signal.aborted || this.disposed) {
        await this.options.release(session);
        return;
      }
      try {
        await this.options.player.loadPaused(session, signal);
      } catch (error) {
        await this.options.release(session).catch(() => undefined);
        throw error;
      }
      signal.throwIfAborted();
      this.reloadRequested = false;
      this.loadedId = state.playbackId;
      this.paused = true;
      this.rate = 1;
      this.alignment = -1;
      this.terminalAlignment = null;
      // Loading may take seconds; use the newest state and clock after it completes.
      this.requested = true;
      return;
    }
    const sample = this.options.player.sample();
    if (sample?.ended === true && this.terminalAlignment === null)
      this.terminalAlignment = this.alignment;
    if (this.terminalAlignment !== null && state.alignmentRevision <= this.terminalAlignment) {
      await this.setRate(1);
      return;
    }
    const force = state.alignmentRevision > this.alignment;
    const now = this.options.now();
    const clock = this.options.clock(now);
    if (clock === null) return;
    if (force) {
      await this.setRate(1);
      await this.setPaused(true);
      signal.throwIfAborted();
      if (this.latest !== snapshot) {
        this.requested = true;
        return;
      }
      const currentClock = this.options.clock(this.options.now());
      if (currentClock === null) return;
      await this.options.player.seekExact(
        positionAt(state, currentClock.serverNowMs) / 1_000,
        signal,
      );
      signal.throwIfAborted();
      this.alignment = state.alignmentRevision;
      this.terminalAlignment = null;
      this.lastSeek = this.options.now();
      if (this.latest !== snapshot) {
        this.requested = true;
        return;
      }
    } else if (sample !== null && (sample.buffering || sample.seeking)) {
      await this.setRate(1);
      this.options.onStatus("synchronizing", null);
      return;
    } else if (
      sample !== null &&
      Number.isFinite(sample.positionSeconds) &&
      sample.positionSeconds >= 0 &&
      now - sample.sampledAtMs >= 0 &&
      now - sample.sampledAtMs <= 500 &&
      sample.uncertaintyMs <= 100
    ) {
      const atSample = this.options.clock(sample.sampledAtMs);
      if (atSample !== null) {
        const correction = chooseCorrection({
          targetMs: positionAt(state, atSample.serverNowMs),
          actualMs: sample.positionSeconds * 1_000,
          playing: state.mode === "playing",
          adjustingRate: this.rate !== 1,
          forceAlignment: false,
        });
        if (correction.type === "seek" && now - this.lastSeek >= 1_500 && clock.fine) {
          await this.setRate(1);
          signal.throwIfAborted();
          // The target is projected again immediately before issuing the seek.
          const latestClock = this.options.clock(this.options.now());
          if (latestClock !== null)
            await this.options.player.seekExact(
              positionAt(state, latestClock.serverNowMs) / 1_000,
              signal,
            );
          signal.throwIfAborted();
          this.lastSeek = this.options.now();
        } else if (correction.type === "rate") await this.setRate(clock.fine ? correction.rate : 1);
        else await this.setRate(1);
      }
    } else await this.setRate(1);
    signal.throwIfAborted();
    if (this.latest !== snapshot) {
      this.requested = true;
      return;
    }
    await this.setPaused(state.mode !== "playing");
    this.failures = 0;
    this.options.onStatus("ready", null);
  }
  private async stop(): Promise<void> {
    if (this.loadedId !== null) {
      await this.setRate(1);
      await this.options.player.stopLocal();
    }
    this.loadedId = null;
    this.alignment = -1;
    this.paused = true;
    this.rate = 1;
    this.terminalAlignment = null;
  }
  private async setRate(rate: number): Promise<void> {
    if (this.rate === rate) return;
    await this.options.player.setPlaybackRate(rate);
    this.rate = rate;
  }
  private async setPaused(paused: boolean): Promise<void> {
    if (this.loadedId === null || this.paused === paused) return;
    await this.options.player.setPaused(paused);
    this.paused = paused;
  }
}
