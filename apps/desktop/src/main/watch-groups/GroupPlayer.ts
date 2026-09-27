import type { IpcPlayerSession } from "@lumen/contracts";
export interface PlayerSample {
  readonly positionSeconds: number;
  readonly sampledAtMs: number;
  readonly uncertaintyMs: number;
  readonly paused: boolean;
  readonly buffering: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
}
export interface GroupPlayer {
  loadPaused(session: IpcPlayerSession, signal: AbortSignal): Promise<void>;
  seekExact(positionSeconds: number, signal: AbortSignal): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  sample(): PlayerSample | null;
  stopLocal(): Promise<void>;
}
