import {
  initialWatchStatus,
  watchCorrection,
  watchPosition,
  type WatchAction,
  type WatchStatus,
} from "@lumen/contracts";
import type { ServerClient } from "../api/ServerClient";
import type { PlayerController } from "../player/PlayerController";
import { WatchGroupClient } from "./WatchGroupClient";

export type WatchPlayer = Pick<
  PlayerController,
  "start" | "stop" | "getState" | "seek" | "pause" | "speed"
>;

export class WatchPlaybackController {
  private client: WatchGroupClient | null = null;
  private connectionId: string | null = null;
  private server: ServerClient | null = null;
  private syncing = false;
  private appliedRevision = -1;
  private appliedGroup: string | null = null;
  private playbackError: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private surfaceReady = false;
  private speed = 1;
  private generation = 0;
  private pendingStop: Promise<void> | null = null;
  private stoppedPlayback: { groupId: string; revision: number } | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  status: WatchStatus = initialWatchStatus();

  constructor(
    private readonly player: WatchPlayer,
    private readonly onStatus: (status: WatchStatus) => void,
  ) {
    this.timer = setInterval(() => void this.synchronize(), 500);
    this.timer.unref();
  }

  connect(server: ServerClient, connectionId: string): void {
    if (this.connectionId === connectionId && this.server === server && this.client !== null)
      return;
    this.disconnect();
    if (!server.supportsWatchGroups) {
      this.status = { ...initialWatchStatus(), connection: "unavailable" };
      this.onStatus(this.status);
      return;
    }
    this.server = server;
    this.connectionId = connectionId;
    this.client = new WatchGroupClient(server, (status) => {
      if (
        status.connection === "connected" &&
        (this.status.connection !== "connected" ||
          status.group?.revision !== this.status.group?.revision)
      ) {
        this.retryAt = 0;
        this.failures = 0;
      }
      if (
        status.group?.id !== this.status.group?.id ||
        status.group?.revision !== this.status.group?.revision ||
        status.group?.playback?.itemId !== this.status.group?.playback?.itemId
      )
        this.playbackError = null;
      this.status = { ...status, error: status.error ?? this.playbackError };
      this.onStatus(this.status);
      void this.synchronize();
    });
    this.client.connect();
  }

  disconnect(): void {
    this.generation += 1;
    this.pendingStop = null;
    this.stoppedPlayback = null;
    const client = this.client;
    this.client = null;
    this.server = null;
    this.connectionId = null;
    client?.close();
    this.playbackError = null;
    this.appliedGroup = null;
    this.appliedRevision = -1;
    this.retryAt = 0;
    this.failures = 0;
    void this.setSpeed(1).catch(() => undefined);
  }

  close(): void {
    clearInterval(this.timer);
    this.disconnect();
  }

  async action(action: WatchAction): Promise<void> {
    const client = this.client;
    if (client === null) throw new Error("Connect to watch groups first");
    await client.action(action);
    if (this.client !== client) return;
    if (action.type === "join" || action.type === "create") {
      this.stoppedPlayback = null;
      void this.synchronize();
    }
    if (action.type === "leave") await this.setSpeed(1);
    if (action.type === "create") {
      const state = this.player.getState();
      if (state !== null) {
        await client.action({
          type: "play",
          itemId: state.itemId,
          positionSeconds: state.positionSeconds,
        });
        if (state.paused)
          await client.action({
            type: "pause",
            itemId: state.itemId,
            paused: true,
            positionSeconds: state.positionSeconds,
          });
      }
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    const group = this.status.group;
    const playback = this.status.group?.playback;
    if (this.pendingStop === null && group?.playback != null)
      this.stoppedPlayback = { groupId: group.id, revision: group.revision };
    this.playbackError = null;
    this.retryAt = 0;
    this.failures = 0;
    if (client?.rejoining) {
      this.disconnect();
    } else if (client !== null && playback != null && this.pendingStop === null) {
      const pending = client
        .action({ type: "stop", itemId: playback.itemId })
        .catch(() => {
          if (this.client !== client) return;
          if (client.rejoining || this.status.connection !== "connected") this.disconnect();
          else {
            const group = this.status.group;
            if (group?.playback != null)
              this.stoppedPlayback = { groupId: group.id, revision: group.revision };
          }
        })
        .finally(() => {
          if (this.pendingStop !== pending) return;
          this.pendingStop = null;
          void this.synchronize();
        });
      this.pendingStop = pending;
    }
    await this.player.stop();
  }

  retry(): void {
    this.retryAt = 0;
    this.failures = 0;
    void this.synchronize();
  }

  setSurfaceReady(ready: boolean): void {
    this.surfaceReady = ready;
    if (ready) void this.synchronize();
  }

  get grouped(): boolean {
    return this.status.group !== null || this.client?.rejoining === true;
  }

  private async setSpeed(speed: number): Promise<void> {
    if (speed === this.speed) return;
    const state = this.player.getState();
    if (state !== null) await this.player.speed(state.sessionId, speed);
    this.speed = speed;
  }

  private async synchronize(): Promise<void> {
    if (this.syncing || this.pendingStop !== null) return;
    const client = this.client;
    const group = this.status.group;
    const generation = this.generation;
    const current = (): boolean =>
      this.generation === generation &&
      this.client === client &&
      this.status.group === group &&
      this.status.connection === "connected";
    if (
      client === null ||
      this.server === null ||
      this.connectionId === null ||
      group === null ||
      this.status.connection !== "connected"
    ) {
      await this.setSpeed(1).catch(() => undefined);
      return;
    }
    if (this.stoppedPlayback?.groupId === group.id) {
      if (group.revision <= this.stoppedPlayback.revision) return;
      this.stoppedPlayback = null;
    }
    if (this.appliedGroup !== group.id) {
      this.appliedGroup = group.id;
      this.appliedRevision = -1;
      this.retryAt = 0;
      this.failures = 0;
    }
    if (Date.now() < this.retryAt) return;
    this.syncing = true;
    try {
      const playback = group.playback;
      let state = this.player.getState();
      if (playback === null) {
        // A freshly created empty group doesn't interrupt the creator's current video.
        if (group.revision > 0 && state !== null) await this.player.stop();
        if (!current()) return;
        this.appliedRevision = group.revision;
        return;
      }
      if (!this.surfaceReady) return;
      if (state === null || state.itemId !== playback.itemId) {
        await this.player.start({
          client: this.server,
          connectionId: this.connectionId,
          itemId: playback.itemId,
          startAtSeconds: watchPosition(playback, client.serverNow),
          paused: true,
        });
        this.speed = 1;
        if (
          this.generation !== generation ||
          this.client !== client ||
          this.status.group?.id !== group.id
        ) {
          await this.player.stop();
          return;
        }
        if (!current()) return;
        state = this.player.getState();
      }
      if (state === null) return;
      const target = Math.min(
        watchPosition(playback, client.serverNow),
        state.durationSeconds ?? Infinity,
      );
      const correction = watchCorrection(state.positionSeconds, target, playback.paused);
      if (this.appliedRevision !== group.revision || correction.seek !== null)
        await this.player.seek(state.sessionId, target);
      if (!current()) return;
      await this.setSpeed(
        this.appliedRevision !== group.revision || correction.seek !== null ? 1 : correction.speed,
      );
      if (!current()) return;
      if (state.paused !== playback.paused)
        await this.player.pause(state.sessionId, playback.paused);
      if (!current()) return;
      this.appliedRevision = group.revision;
      this.failures = 0;
      this.playbackError = null;
      if (this.status.error !== null) {
        this.status = { ...this.status, error: null };
        this.onStatus(this.status);
      }
    } catch (cause) {
      if (current()) {
        this.retryAt = Date.now() + Math.min(10_000, 1000 * 2 ** this.failures++);
        this.playbackError =
          cause instanceof Error ? cause.message : "Could not synchronize playback";
        this.status = { ...this.status, error: this.playbackError };
        this.onStatus(this.status);
      }
    } finally {
      this.syncing = false;
    }
  }
}
