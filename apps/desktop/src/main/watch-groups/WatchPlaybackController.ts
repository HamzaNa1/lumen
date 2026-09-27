import {
  watchCorrection,
  watchPosition,
  type WatchAction,
  type WatchStatus,
} from "@lumen/contracts";
import type { ServerClient } from "../api/ServerClient";
import type { PlayerController } from "../player/PlayerController";
import { WatchGroupClient } from "./WatchGroupClient";

export class WatchPlaybackController {
  private client: WatchGroupClient | null = null;
  private connectionId: string | null = null;
  private server: ServerClient | null = null;
  private syncing = false;
  private appliedRevision = -1;
  private appliedGroup: string | null = null;
  private failedRevision: number | null = null;
  private speed = 1;
  private readonly timer: ReturnType<typeof setInterval>;
  status: WatchStatus = {
    connection: "offline",
    memberId: null,
    groups: [],
    group: null,
    error: null,
  };

  constructor(
    private readonly player: PlayerController,
    private readonly onStatus: (status: WatchStatus) => void,
  ) {
    this.timer = setInterval(() => void this.synchronize(), 500);
    this.timer.unref();
  }

  connect(server: ServerClient, connectionId: string): void {
    if (this.connectionId === connectionId && this.client !== null) return;
    this.disconnect();
    this.server = server;
    this.connectionId = connectionId;
    this.client = new WatchGroupClient(server, (status) => {
      this.status = status;
      this.onStatus(status);
      void this.synchronize();
    });
    this.client.connect();
  }

  disconnect(): void {
    const client = this.client;
    this.client = null;
    this.server = null;
    this.connectionId = null;
    client?.close();
    this.appliedGroup = null;
    this.appliedRevision = -1;
    this.failedRevision = null;
    void this.setSpeed(1).catch(() => undefined);
  }

  close(): void {
    clearInterval(this.timer);
    this.disconnect();
  }

  async action(action: WatchAction): Promise<void> {
    if (this.client === null) throw new Error("Connect to watch groups first");
    await this.client.action(action);
    if (action.type === "leave") await this.setSpeed(1);
    if (action.type === "create") {
      const state = this.player.getState();
      if (state !== null) {
        await this.client.action({
          type: "play",
          itemId: state.itemId,
          positionSeconds: state.positionSeconds,
        });
        if (state.paused)
          await this.client.action({
            type: "pause",
            itemId: state.itemId,
            paused: true,
            positionSeconds: state.positionSeconds,
          });
      }
    }
  }

  get grouped(): boolean {
    return this.status.group !== null;
  }

  private async setSpeed(speed: number): Promise<void> {
    if (speed === this.speed) return;
    const state = this.player.getState();
    if (state !== null) await this.player.speed(state.sessionId, speed);
    this.speed = speed;
  }

  private async synchronize(): Promise<void> {
    if (this.syncing) return;
    const client = this.client;
    const group = this.status.group;
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
    if (this.appliedGroup !== group.id) {
      this.appliedGroup = group.id;
      this.appliedRevision = -1;
      this.failedRevision = null;
    }
    if (this.failedRevision === group.revision) return;
    this.syncing = true;
    try {
      const playback = group.playback;
      let state = this.player.getState();
      if (playback === null) {
        // A freshly created empty group doesn't interrupt the creator's current video.
        if (group.revision > 0 && this.appliedRevision !== group.revision) await this.player.stop();
        this.appliedRevision = group.revision;
        return;
      }
      if (state === null || state.itemId !== playback.itemId) {
        await this.player.start({
          client: this.server,
          connectionId: this.connectionId,
          itemId: playback.itemId,
          startAtSeconds: watchPosition(playback, client.serverNow),
          paused: true,
        });
        this.speed = 1;
        if (this.client !== client || this.status.group?.id !== group.id) {
          await this.player.stop();
          return;
        }
        if (this.status.group.revision !== group.revision) return;
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
      await this.setSpeed(correction.speed);
      if (state.paused !== playback.paused)
        await this.player.pause(state.sessionId, playback.paused);
      this.appliedRevision = group.revision;
    } catch (cause) {
      if (this.client === client && this.status.group?.id === group.id) {
        this.failedRevision = group.revision;
        this.status = {
          ...this.status,
          error: cause instanceof Error ? cause.message : "Could not synchronize playback",
        };
        this.onStatus(this.status);
      }
    } finally {
      this.syncing = false;
    }
  }
}
