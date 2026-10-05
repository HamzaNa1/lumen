import type { PlayerState } from "@lumen/contracts";

export interface PlaybackSessionApi {
  readonly heartbeat: (sessionId: string, state: PlayerState) => Promise<void>;
  readonly progress: (sessionId: string, state: PlayerState, sequence: number) => Promise<void>;
  readonly stopPlayback: (sessionId: string) => Promise<void>;
}

/** The player samples on this cadence; heartbeats and saved progress are slower multiples of it. */
export const PLAYBACK_REPORT_INTERVAL_MS = 3_000;
const HEARTBEAT_EVERY_TICKS = 3;
const PROGRESS_EVERY_TICKS = 6;

/**
 * Tells the server how one playback session is going: periodic heartbeats, saved progress, and
 * the end of the session.
 *
 * Every progress write carries a sequence number that only increases, so the server can discard
 * a slow periodic write that arrives after a newer save. Once retired, a session reports nothing
 * further on its own, which keeps a replaced session from overwriting its successor.
 */
export class PlaybackSessionReporter {
  private ticks = 0;
  private sequence = 0;
  private reporting = false;
  private retired = false;
  private ending: Promise<void> | null = null;

  constructor(
    private readonly api: PlaybackSessionApi,
    private readonly sessionId: string,
    private readonly onError: (cause: unknown) => void,
  ) {}

  /** One step of the periodic schedule. A step still waiting on the server is not repeated. */
  async tick(state: PlayerState): Promise<void> {
    if (this.retired || this.reporting) return;
    this.reporting = true;
    try {
      this.ticks += 1;
      this.sequence += 1;
      const sequence = this.sequence;
      if (this.ticks % HEARTBEAT_EVERY_TICKS === 0) await this.api.heartbeat(this.sessionId, state);
      if (this.retired) return;
      if (this.ticks % PROGRESS_EVERY_TICKS === 0)
        await this.api.progress(this.sessionId, state, sequence);
    } catch (cause) {
      if (!this.retired) this.onError(cause);
    } finally {
      this.reporting = false;
    }
  }

  /** Saves progress now, ahead of any periodic write still in flight. */
  async saveProgress(state: PlayerState): Promise<void> {
    this.sequence += 1;
    try {
      await this.api.progress(this.sessionId, state, this.sequence);
    } catch (cause) {
      this.onError(cause);
    }
  }

  /** Stops periodic reporting. Progress can still be saved explicitly while the session winds down. */
  retire(): void {
    this.retired = true;
  }

  /** Ends the session on the server. A session that cannot be reached expires there on its own. */
  end(): Promise<void> {
    this.retired = true;
    this.ending ??= this.api.stopPlayback(this.sessionId).catch(() => undefined);
    return this.ending;
  }
}
