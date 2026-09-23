import { EventEmitter } from "node:events";
import type { IpcPlayerSession, IpcPlayerState } from "@lumen/contracts";
import { app } from "electron";
import { ServerClient } from "../api/ServerClient";
import { MpvIpc } from "./MpvIpc";
import { MpvProcess } from "./MpvProcess";
import { PlaybackBridge } from "./PlaybackBridge";

export interface PlayerControllerOptions {
  readonly bridge: PlaybackBridge;
  readonly onState: (state: IpcPlayerState) => void;
}

interface ActiveSession {
  readonly session: IpcPlayerSession;
  readonly client: ServerClient;
  readonly connectionId: string;
  readonly process: MpvProcess;
  readonly ipc: MpvIpc;
  readonly capability: string;
  sequence: number;
}

export class PlayerController extends EventEmitter {
  private readonly bridge: PlaybackBridge;
  private readonly onState: (state: IpcPlayerState) => void;
  private active: ActiveSession | null = null;
  private state: IpcPlayerState | null = null;

  constructor(options: PlayerControllerOptions) {
    super();
    this.bridge = options.bridge;
    this.onState = options.onState;
  }

  async start(input: { readonly client: ServerClient; readonly connectionId: string; readonly itemId: string; readonly deviceId: string }): Promise<IpcPlayerSession> {
    await this.stop();
    const session = await input.client.startPlayback(input.itemId, input.deviceId);
    const playerProcess = MpvProcess.start({
      cwd: process.cwd(),
      resourcesPath: process.resourcesPath,
      onExit: () => this.emit("ended"),
    });
    const ipc = new MpvIpc();
    await ipc.connect(playerProcess);
    const registered = this.bridge.register({
      connectionId: input.connectionId,
      serverClient: input.client,
      streamPath: new URL(session.streamUrl, input.client.serverOrigin).pathname,
      bearer: session.grantToken,
      active: () => this.active?.session.sessionId === session.sessionId,
    });
    const capability = registered.capability;
    const streamUrl = registered.url;
    this.active = { session, client: input.client, connectionId: input.connectionId, process: playerProcess, ipc, capability, sequence: 0 };
    await ipc.command(["loadfile", streamUrl, "replace"]);
    await ipc.command(["set_property", "pause", "no"]);
    this.state = {
      sessionId: session.sessionId,
      itemId: session.itemId,
      paused: false,
      positionSeconds: 0,
      durationSeconds: session.durationSeconds,
      volume: 100,
      muted: false,
      ended: false,
    };
    this.publish();
    return this.sanitized(session);
  }

  pause(sessionId: string, paused: boolean): IpcPlayerState {
    this.assertActive(sessionId);
    this.state = { ...this.requireState(), paused };
    this.active?.ipc.command(["set_property", "pause", paused ? "yes" : "no"]).catch(() => this.emit("error"));
    this.publish();
    return this.requireState();
  }

  seek(sessionId: string, positionSeconds: number): IpcPlayerState {
    this.assertActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) throw new Error("Invalid position");
    this.active?.ipc.command(["seek", positionSeconds, "absolute"]).catch(() => this.emit("error"));
    this.state = { ...this.requireState(), positionSeconds, ended: false };
    this.publish();
    return this.requireState();
  }

  volume(sessionId: string, volume: number, muted = false): IpcPlayerState {
    this.assertActive(sessionId);
    const bounded = Math.max(0, Math.min(100, Math.round(volume)));
    this.active?.ipc.command(["set_property", "volume", bounded]).catch(() => this.emit("error"));
    this.active?.ipc.command(["set_property", "mute", muted ? "yes" : "no"]).catch(() => this.emit("error"));
    this.state = { ...this.requireState(), volume: bounded, muted };
    this.publish();
    return this.requireState();
  }

  getState(): IpcPlayerState | null {
    return this.state;
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = null;
    this.state = null;
    if (active === null) return;
    this.bridge.revoke(active.capability);
    active.ipc.close();
    active.process.stop();
    try {
      await active.client.request(`/api/v1/playback/sessions/${encodeURIComponent(active.session.sessionId)}`, { method: "DELETE" });
    } catch {}
  }

  async tick(): Promise<void> {
    const active = this.active;
    if (active === null || this.state === null) return;
    try {
      const value = await active.ipc.command(["get_property", "time-pos"]);
      const duration = await active.ipc.command(["get_property", "duration"]);
      const paused = await active.ipc.command(["get_property", "pause"]);
      const ended = await active.ipc.command(["get_property", "eof-reached"]);
      const next: IpcPlayerState = {
        ...this.state,
        positionSeconds: typeof value === "number" && value >= 0 ? value : this.state.positionSeconds,
        durationSeconds: typeof duration === "number" && duration >= 0 ? duration : this.state.durationSeconds,
        paused: paused === true,
        ended: ended === true,
      };
      this.state = next;
      this.publish();
      active.sequence += 1;
      if (active.sequence % 3 === 0) await active.client.heartbeat(next.sessionId, next);
      if (active.sequence % 6 === 0) await active.client.progress(next.sessionId, next, active.sequence);
    } catch (cause) {
      this.emit("error", cause);
    }
  }

  private assertActive(sessionId: string): void {
    if (this.active === null || this.active.session.sessionId !== sessionId) throw new Error("Playback session is not active");
  }

  private requireState(): IpcPlayerState {
    if (this.state === null) throw new Error("Playback state is unavailable");
    return this.state;
  }

  private publish(): void {
    if (this.state !== null) this.onState(this.state);
  }

  private sanitized(session: IpcPlayerSession): IpcPlayerSession {
    const { grantToken: _grantToken, ...safe } = session;
    return safe as IpcPlayerState & IpcPlayerSession;
  }
}

export const startNativePlayer = (controller: PlayerController): void => {
  void app.whenReady();
  setInterval(() => void controller.tick(), 3_000).unref();
};
