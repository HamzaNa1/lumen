import {
  type CreateWatchGroup,
  type WatchGroupCommand,
  type WatchGroupSnapshot,
  type WatchGroupStatus,
  type WatchGroupPlayback,
  watchGroupPosition,
} from "@lumen/contracts";
import { ServerHttpError, type ServerClient } from "../api/ServerClient";
import type { PlayerController } from "./PlayerController";

export class WatchGroupController {
  private status: WatchGroupStatus = { group: null, connected: true, error: null };
  private connection: { client: ServerClient; connectionId: string } | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private applying: Promise<void> | null = null;
  private playbackId: string | null = null;
  private revision = -1;
  private loadingId: string | null = null;
  private serverTimeMs = 0;
  private clockSampledAt = 0;
  private lastResponseAt = 0;
  private membershipChange = false;
  private retryAt = 0;

  constructor(
    private readonly player: PlayerController,
    private readonly onStatus: (status: WatchGroupStatus) => void,
    private readonly onPlayback: (itemId: string | null, title: string | null) => void,
  ) {}

  getState(): WatchGroupStatus {
    return this.status;
  }

  async enter(
    connection: { client: ServerClient; connectionId: string },
    input: { create: CreateWatchGroup } | { groupId: string; password?: string },
  ): Promise<WatchGroupStatus> {
    if (this.membershipChange || this.status.group !== null)
      throw new Error("Leave your current watch group first");
    this.membershipChange = true;
    try {
      await this.calibrateClock(connection.client);
      const snapshot =
        "create" in input
          ? await connection.client.createWatchGroup(input.create)
          : await connection.client.joinWatchGroup(input.groupId, input.password);
      this.connection = connection;
      this.abort = new AbortController();
      this.accept(snapshot);
      this.timer = setInterval(() => void this.reconcile(), 250);
      this.timer.unref();
      void this.poll(this.abort.signal);
      // Creating a group during playback shares the creator's current show.
      const current = this.player.getState();
      if ("create" in input && current !== null) {
        await this.command({
          type: "start",
          itemId: current.itemId,
          positionSeconds: current.positionSeconds,
        });
        if (current.paused) await this.control("pause");
      } else {
        if (snapshot.group?.playback === null && current !== null) {
          await this.player.stop();
          this.onPlayback(null, null);
        }
        await this.reconcile();
      }
      return this.status;
    } finally {
      this.membershipChange = false;
    }
  }

  async leave(): Promise<WatchGroupStatus> {
    if (this.membershipChange) throw new Error("A watch group request is still in progress");
    const connection = this.connection;
    const group = this.status.group;
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.connection = null;
    this.status = { group: null, connected: true, error: null };
    this.onStatus(this.status);
    if (this.loadingId !== null) await this.player.stop();
    await this.applying;
    this.playbackId = null;
    this.revision = -1;
    await this.player.resetSpeed();
    if (connection !== null && group !== null) {
      try {
        await connection.client.leaveWatchGroup(group.id);
      } catch (cause) {
        this.status = {
          ...this.status,
          error: `Left locally. The server will remove this device after its connection expires. ${cause instanceof Error ? cause.message : ""}`,
        };
        this.onStatus(this.status);
      }
    }
    return this.status;
  }

  async command(command: WatchGroupCommand): Promise<void> {
    const connection = this.connection;
    const group = this.status.group;
    if (connection === null || group === null) throw new Error("Join a watch group first");
    try {
      const snapshot = await connection.client.watchGroupCommand(group.id, command);
      if (this.connection !== connection || this.status.group?.id !== group.id) return;
      this.accept(snapshot);
      await this.reconcile();
    } catch (cause) {
      this.report(cause);
      throw cause;
    }
  }

  async control(type: "pause" | "resume" | "stop" | "seek", positionSeconds = 0): Promise<void> {
    const playback = this.status.group?.playback;
    if (playback == null) return;
    await this.command(
      type === "seek"
        ? { type, playbackId: playback.id, positionSeconds }
        : { type, playbackId: playback.id },
    );
  }

  private accept(snapshot: WatchGroupSnapshot): void {
    if (
      this.status.group !== null &&
      snapshot.group !== null &&
      snapshot.group.revision < this.status.group.revision
    )
      return;
    if (this.status.group?.playback?.revision !== snapshot.group?.playback?.revision)
      this.retryAt = 0;
    this.lastResponseAt = performance.now();
    this.status = { group: snapshot.group, connected: true, error: null };
    if (this.loadingId !== null && this.loadingId !== snapshot.group?.playback?.id)
      void this.player.stop().catch((cause) => this.report(cause));
    this.onStatus(this.status);
  }

  private async calibrateClock(client: ServerClient): Promise<void> {
    const before = performance.now();
    const result = await client.watchGroups();
    const after = performance.now();
    this.serverTimeMs = result.serverTimeMs + (after - before) / 2;
    this.clockSampledAt = after;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.connection !== null && this.status.group !== null) {
      const connection = this.connection;
      const group = this.status.group;
      try {
        if (performance.now() - this.clockSampledAt > 30_000)
          await this.calibrateClock(connection.client);
        const result = await connection.client.watchGroupState(group.id, group.revision, signal);
        if (signal.aborted) return;
        this.accept(result);
        void this.reconcile();
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ServerHttpError && [401, 403, 404].includes(cause.status)) {
          await this.leave();
          this.report(
            new Error("The watch group ended or your membership expired. Join again to sync."),
          );
          return;
        }
        this.status = { ...this.status, connected: false };
        this.report(new Error("Connection lost. Reconnecting to the watch group…"));
        await this.player.resetSpeed().catch(() => undefined);
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 2_000);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }

  private reconcile(): Promise<void> {
    if (this.applying !== null) return this.applying;
    const operation = this.apply().catch((cause: unknown) => {
      this.retryAt = performance.now() + 5_000;
      this.report(cause);
    });
    this.applying = operation;
    void operation.finally(() => {
      if (this.applying === operation) this.applying = null;
    });
    return operation;
  }

  private async apply(): Promise<void> {
    const connection = this.connection;
    const group = this.status.group;
    if (
      connection === null ||
      group === null ||
      !this.status.connected ||
      performance.now() < this.retryAt
    )
      return;
    if (performance.now() - this.lastResponseAt > 15_000) {
      await this.player.resetSpeed();
      return;
    }
    const playback = group.playback;
    if (playback === null) {
      if (this.playbackId !== null) {
        this.playbackId = null;
        await this.player.stop();
        this.onPlayback(null, null);
      }
      return;
    }
    if (this.playbackId !== playback.id) {
      this.loadingId = playback.id;
      this.onPlayback(playback.itemId, playback.title);
      try {
        await this.player.waitForSurface();
        if (this.connection !== connection || this.status.group?.playback?.id !== playback.id)
          return;
        await this.player.start({
          ...connection,
          itemId: playback.itemId,
          startAtSeconds: this.position(playback),
          paused: true,
        });
        if (this.connection !== connection || this.status.group?.playback?.id !== playback.id)
          return;
        this.playbackId = playback.id;
        this.revision = -1;
      } catch (cause) {
        if (this.connection === connection && this.status.group?.playback?.id === playback.id)
          throw cause;
        return;
      } finally {
        this.loadingId = null;
      }
    }
    const current = this.status.group?.playback;
    if (current == null || current.id !== playback.id) return;
    await this.player.synchronize(
      this.position(current),
      current.paused,
      this.revision !== current.revision,
    );
    this.revision = current.revision;
  }

  private position(playback: WatchGroupPlayback): number {
    return watchGroupPosition(
      playback,
      this.serverTimeMs + performance.now() - this.clockSampledAt,
    );
  }

  private report(cause: unknown): void {
    this.status = { ...this.status, error: cause instanceof Error ? cause.message : String(cause) };
    this.onStatus(this.status);
  }
}
