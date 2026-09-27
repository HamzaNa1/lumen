import type { IpcPlayerSession } from "../../packages/contracts/src";
import type {
  GroupPlayer,
  PlayerSample,
} from "../../apps/desktop/src/main/watch-groups/GroupPlayer";
export class FakePlayer implements GroupPlayer {
  now = 0;
  position = 0;
  paused = true;
  rate = 1;
  loads = 0;
  seeks: number[] = [];
  stopped = 0;
  buffering = false;
  ended = false;
  loading: (() => Promise<void>) | null = null;
  async loadPaused(_session: IpcPlayerSession, signal: AbortSignal) {
    this.loads++;
    this.paused = true;
    if (this.loading !== null) await this.loading();
    signal.throwIfAborted();
  }
  async seekExact(position: number) {
    this.seeks.push(position);
    this.position = position;
    this.ended = false;
  }
  async setPaused(paused: boolean) {
    this.paused = paused;
  }
  async setPlaybackRate(rate: number) {
    this.rate = rate;
  }
  sample(): PlayerSample {
    return {
      positionSeconds: this.position,
      sampledAtMs: this.now,
      uncertaintyMs: 0,
      paused: this.paused,
      buffering: this.buffering,
      seeking: false,
      ended: this.ended,
    };
  }
  async stopLocal() {
    this.stopped++;
    this.paused = true;
  }
}
export const session = {
  sessionId: crypto.randomUUID(),
  itemId: crypto.randomUUID(),
  sourceId: crypto.randomUUID(),
  title: "Film",
  streamUrl: "/stream",
  durationSeconds: 120,
  streams: [],
  grantToken: "secret",
  grantExpiresInSeconds: 3600,
} satisfies IpcPlayerSession;
