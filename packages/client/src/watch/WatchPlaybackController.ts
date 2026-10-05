import {
  initialWatchStatus,
  watchCorrection,
  watchPosition,
  type PlayerState,
  type WatchAction,
  type WatchGroup,
  type WatchStatus,
} from "@lumen/contracts";
import { PlaybackUnsupportedError } from "../errors.ts";
import { type WatchConnection, WatchGroupClient } from "./WatchGroupClient.ts";

export interface WatchServer extends WatchConnection {
  readonly supportsWatchGroups: boolean;
}

/** The part of a player that watch groups drive. Any platform's player can stand behind it. */
export interface WatchPlayer<Server extends WatchServer> {
  readonly start: (input: {
    readonly server: Server;
    readonly connectionId: string;
    readonly itemId: string;
    readonly startAtSeconds?: number;
    readonly paused?: boolean;
  }) => Promise<unknown>;
  readonly stop: () => Promise<void>;
  readonly getState: () => Pick<
    PlayerState,
    "sessionId" | "itemId" | "positionSeconds" | "durationSeconds" | "paused"
  > | null;
  readonly seek: (sessionId: string, positionSeconds: number) => Promise<unknown>;
  readonly pause: (sessionId: string, paused: boolean) => Promise<unknown>;
  readonly speed: (sessionId: string, speed: number) => Promise<void>;
  /** Whether the player has fetched what it needs to play from where it now is. */
  readonly loaded: (sessionId: string) => boolean | Promise<boolean>;
}

const SYNCHRONIZE_INTERVAL_MS = 500;
// A group holding for this viewer should hear that its position has loaded without delay.
const READINESS_INTERVAL_MS = 100;

/**
 * Keeps one viewer's player in step with their watch group.
 *
 * Commands flow one way: the group's shared state is applied to the local player. A local player
 * that fails or cannot play the file only reports the problem to its own viewer; nothing here
 * sends the group a pause, seek or stop on the player's behalf. The one thing a player does tell
 * the group is that it has loaded a position the group is holding at, so playback can begin.
 */
export class WatchPlaybackController<Server extends WatchServer = WatchServer> {
  private client: WatchGroupClient | null = null;
  private connectionId: string | null = null;
  private server: Server | null = null;
  private syncing = false;
  private appliedRevision = -1;
  private appliedGroup: string | null = null;
  private playbackError: string | null = null;
  private stoppedAfterFailure = false;
  private retryAt = 0;
  private failures = 0;
  private surfaceReady = false;
  private speed = 1;
  private generation = 0;
  private pendingStop: Promise<void> | null = null;
  private stoppedPlayback: { groupId: string; revision: number } | null = null;
  /** The group revision, as `groupId:revision`, already told not to wait for this viewer. */
  private reportedReady: string | null = null;
  /** Where the group was holding when its playback was last applied, if it was holding. */
  private heldPosition: number | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  status: WatchStatus = initialWatchStatus();

  constructor(
    private readonly player: WatchPlayer<Server>,
    private readonly onStatus: (status: WatchStatus) => void,
  ) {
    this.timer = setInterval(() => void this.synchronize(), SYNCHRONIZE_INTERVAL_MS);
  }

  connect(server: Server, connectionId: string): void {
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
    const onStatus = (status: WatchStatus): void => {
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
    };
    this.client = new WatchGroupClient(server, onStatus, true);
    this.client.connect();
  }

  disconnect(): void {
    this.generation += 1;
    this.pendingStop = null;
    this.stoppedPlayback = null;
    this.reportedReady = null;
    clearTimeout(this.readinessTimer);
    const client = this.client;
    this.client = null;
    this.server = null;
    this.connectionId = null;
    client?.close();
    this.playbackError = null;
    this.stoppedAfterFailure = false;
    this.appliedGroup = null;
    this.appliedRevision = -1;
    this.heldPosition = null;
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
      this.stoppedAfterFailure = false;
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
    // A viewer whose own player failed is only giving up locally. Everyone else is still
    // watching, so the group is not asked to stop. Keep that decision through repeated route
    // cleanup, even across group revisions, until local playback succeeds or membership changes.
    this.stoppedAfterFailure ||= this.playbackError !== null;
    const localOnly = this.stoppedAfterFailure || this.stoppedHere(group);
    const playback = localOnly ? null : group?.playback;
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

  /**
   * The local player stopped working on its own, after the group's playback had been applied.
   * Until this is recorded the failure looks like the viewer choosing to stop, and stopping
   * would be passed on to the whole group.
   */
  playerFailed(cause: unknown): void {
    if (this.status.group?.playback != null) this.recordFailure(cause);
  }

  private recordFailure(cause: unknown): void {
    // A file this device cannot play will not start working on its own: wait for the group
    // to move on, or for the viewer to ask again.
    this.retryAt =
      cause instanceof PlaybackUnsupportedError
        ? Number.POSITIVE_INFINITY
        : Date.now() + Math.min(10_000, 1000 * 2 ** this.failures++);
    this.playbackError = cause instanceof Error ? cause.message : "Could not synchronize playback";
    this.status = { ...this.status, error: this.playbackError };
    this.onStatus(this.status);
  }

  /** Call after the device slept or lost its network, to reconnect and catch up immediately. */
  resume(): void {
    this.client?.resume();
    this.retry();
  }

  setSurfaceReady(ready: boolean): void {
    this.surfaceReady = ready;
    if (ready) void this.synchronize();
  }

  get grouped(): boolean {
    return this.status.group !== null || this.client?.rejoining === true;
  }

  /** This viewer already stopped the group's playback, as it stands, on this device. */
  private stoppedHere(group: WatchStatus["group"]): boolean {
    return (
      group != null &&
      this.stoppedPlayback?.groupId === group.id &&
      group.revision <= this.stoppedPlayback.revision
    );
  }

  /** The group is holding its playback until this viewer, among others, has loaded it. */
  private awaited(group: WatchGroup): boolean {
    const memberId = this.status.memberId;
    return memberId !== null && group.playback?.waitingFor?.includes(memberId) === true;
  }

  /**
   * Tells a group that is holding for this viewer to stop waiting: either its position has
   * loaded here, or this device is not going to play it.
   */
  private reportReady(client: WatchGroupClient, group: WatchGroup): void {
    const reported = `${group.id}:${group.revision}`;
    if (this.reportedReady === reported || !this.awaited(group)) return;
    this.reportedReady = reported;
    void client.action({ type: "ready", revision: group.revision }).catch(() => {
      if (this.reportedReady === reported) this.reportedReady = null;
    });
  }

  private checkReadinessSoon(): void {
    clearTimeout(this.readinessTimer);
    this.readinessTimer = setTimeout(() => void this.synchronize(), READINESS_INTERVAL_MS);
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
    // The same playback may arrive again with other members or a shorter wait; that is no
    // reason to abandon applying it.
    const current = (): boolean =>
      this.generation === generation &&
      this.client === client &&
      this.status.group?.id === group?.id &&
      this.status.group?.revision === group?.revision &&
      this.status.group?.playback?.itemId === group?.playback?.itemId &&
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
    if (this.stoppedHere(group)) {
      this.reportReady(client, group);
      return;
    }
    if (this.stoppedPlayback?.groupId === group.id) this.stoppedPlayback = null;
    if (this.appliedGroup !== group.id) {
      this.appliedGroup = group.id;
      this.appliedRevision = -1;
    this.heldPosition = null;
      this.retryAt = 0;
      this.failures = 0;
    }
    if (Date.now() < this.retryAt) {
      // The group should not wait on a player that is failing here.
      this.reportReady(client, group);
      return;
    }
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
          server: this.server,
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
      const awaited = this.awaited(group);
      if (
        awaited &&
        this.appliedRevision === group.revision &&
        !(await this.player.loaded(state.sessionId))
      ) {
        // Still loading the position the group holds at; another seek would start that over.
        this.checkReadinessSoon();
        return;
      }
      if (!current()) return;
      const target = Math.min(
        watchPosition(playback, client.serverNow),
        state.durationSeconds ?? Infinity,
      );
      const correction = watchCorrection(state.positionSeconds, target, playback.paused);
      // A held group that starts playing does so from where this player already waits; seeking
      // there again would only make it load again.
      const released = !playback.paused && this.heldPosition === playback.positionSeconds;
      const reposition =
        correction.seek !== null || (this.appliedRevision !== group.revision && !released);
      if (reposition) await this.player.seek(state.sessionId, target);
      if (!current()) return;
      await this.setSpeed(reposition ? 1 : correction.speed);
      if (!current()) return;
      if (state.paused !== playback.paused)
        await this.player.pause(state.sessionId, playback.paused);
      if (!current()) return;
      this.appliedRevision = group.revision;
      this.heldPosition = playback.waitingFor === undefined ? null : playback.positionSeconds;
      this.failures = 0;
      this.playbackError = null;
      this.stoppedAfterFailure = false;
      if (this.status.error !== null) {
        this.status = { ...this.status, error: null };
        this.onStatus(this.status);
      }
      if (!awaited) return;
      if (await this.player.loaded(state.sessionId)) this.reportReady(client, group);
      else this.checkReadinessSoon();
    } catch (cause) {
      if (current()) this.recordFailure(cause);
    } finally {
      this.syncing = false;
    }
  }
}
