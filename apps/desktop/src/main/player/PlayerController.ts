import { EventEmitter } from "node:events";
import type { IpcPlayerSession, IpcPlayerState, IpcPlayerSurfaceBounds } from "@lumen/contracts";
import { app } from "electron";
import type { ServerClient } from "../api/ServerClient";
import { MpvIpc } from "./MpvIpc";
import { MpvProcess } from "./MpvProcess";
import type { MpvSurface } from "./MpvSurface";
import type { PlaybackBridge } from "./PlaybackBridge";

export interface PlayerControllerOptions {
  readonly bridge: PlaybackBridge;
  readonly surface: MpvSurface;
  readonly onState: (state: IpcPlayerState) => void;
}

interface MpvTrack {
  readonly id: number;
  readonly type: "audio" | "sub";
  readonly "ff-index"?: number;
}

interface ActiveSession {
  readonly session: IpcPlayerSession;
  readonly client: ServerClient;
  readonly connectionId: string;
  readonly process: MpvProcess;
  readonly ipc: MpvIpc;
  readonly capability: string;
  readonly trackIds: ReadonlyMap<string, number>;
  sequence: number;
}

interface PlaybackResources {
  readonly session: IpcPlayerSession;
  readonly client: ServerClient;
  readonly process: MpvProcess | null;
  readonly ipc: MpvIpc | null;
  readonly capability: string | null;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const FILE_LOADED_TIMEOUT_MS = 15_000;

const isPropertyUnavailable = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes("property unavailable");

const resolveTrackIds = async (
  ipc: MpvIpc,
  streams: IpcPlayerSession["streams"],
): Promise<ReadonlyMap<string, number>> => {
  const trackIds = new Map<string, number>();
  for (let attempt = 0; attempt < 40 && trackIds.size < streams.length; attempt += 1) {
    const value = await ipc.command(["get_property", "track-list"]);
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (typeof candidate !== "object" || candidate === null) continue;
        const track = candidate as MpvTrack;
        if (
          !Number.isInteger(track.id) ||
          (track.type !== "audio" && track.type !== "sub") ||
          !Number.isInteger(track["ff-index"])
        )
          continue;
        const ordinal = track["ff-index"] as number;
        const stream = streams.find(
          (candidateStream) =>
            candidateStream.ordinal === ordinal &&
            candidateStream.kind === (track.type === "audio" ? "audio" : "subtitle"),
        );
        if (stream !== undefined) trackIds.set(stream.id, track.id);
      }
    }
    if (trackIds.size < streams.length) await wait(50);
  }
  return trackIds;
};

export class PlayerController extends EventEmitter {
  private readonly bridge: PlaybackBridge;
  private readonly surface: MpvSurface;
  private readonly onState: (state: IpcPlayerState) => void;
  private active: ActiveSession | null = null;
  private state: IpcPlayerState | null = null;
  private startGeneration = 0;
  private stopping: Promise<void> | null = null;
  private stoppingProcess: MpvProcess | null = null;

  constructor(options: PlayerControllerOptions) {
    super();
    this.bridge = options.bridge;
    this.surface = options.surface;
    this.onState = options.onState;
  }

  async start(input: {
    readonly client: ServerClient;
    readonly connectionId: string;
    readonly itemId: string;
  }): Promise<IpcPlayerSession> {
    const generation = ++this.startGeneration;
    await this.stopActive();
    if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
    const session = await input.client.startPlayback(input.itemId);
    let playerProcess: MpvProcess | null = null;
    let ipc: MpvIpc | null = null;
    let capability: string | null = null;
    try {
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      playerProcess = MpvProcess.start({
        cwd: process.cwd(),
        resourcesPath: process.resourcesPath,
        videoOutputArguments: this.surface.prepare(),
        onExit: () => this.emit("ended"),
      });
      ipc = new MpvIpc();
      await ipc.connect(playerProcess);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      const registered = this.bridge.register({
        connectionId: input.connectionId,
        serverClient: input.client,
        streamPath: new URL(session.streamUrl, input.client.serverOrigin).pathname,
        bearer: session.grantToken,
        active: () => this.active?.session.sessionId === session.sessionId,
      });
      capability = registered.capability;
      const streamUrl = registered.url;
      const active: ActiveSession = {
        session,
        client: input.client,
        connectionId: input.connectionId,
        process: playerProcess,
        ipc,
        capability,
        trackIds: new Map(),
        sequence: 0,
      };
      this.active = active;
      // The loadfile ack only means mpv accepted the command, not that the
      // file demuxed. Wait for file-loaded and fail fast on end-file/error
      // (e.g. "unrecognized file format") so callers surface the real cause
      // instead of black-screen + `property unavailable` ticks.
      let detachLoadListeners = (): void => undefined;
      const mpv: MpvIpc = ipc;
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          detachLoadListeners();
          reject(new Error("Timed out waiting for media to load"));
        }, FILE_LOADED_TIMEOUT_MS);
        const onLoaded = (): void => {
          detachLoadListeners();
          resolve();
        };
        const onEndFile = (event: unknown): void => {
          const reason = (event as { readonly reason?: unknown } | null)?.reason;
          const fileError = (event as { readonly file_error?: unknown } | null)?.file_error;
          if (reason === "error") {
            detachLoadListeners();
            reject(
              new Error(
                typeof fileError === "string" && fileError.length > 0
                  ? `Playback failed: ${fileError}`
                  : "Playback failed",
              ),
            );
          }
        };
        detachLoadListeners = (): void => {
          clearTimeout(timer);
          mpv.off("file-loaded", onLoaded);
          mpv.off("end-file", onEndFile);
        };
        mpv.on("file-loaded", onLoaded);
        mpv.on("end-file", onEndFile);
      });
      try {
        await ipc.command(["set_property", "pause", "yes"]);
        await ipc.command(["loadfile", streamUrl, "replace"]);
        await loaded;
      } finally {
        detachLoadListeners();
      }
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      if (process.platform === "darwin") {
        const windowId = await ipc.command(["get_property", "window-id"]);
        if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
        if (typeof windowId !== "number" || !Number.isSafeInteger(windowId) || windowId <= 0) {
          throw new Error("MPV did not create a native video window");
        }
        this.surface.attachNativeWindow(windowId);
      }
      const trackIds = await resolveTrackIds(ipc, session.streams);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      this.active = { ...active, trackIds };
      const streams = session.streams.filter((stream) => trackIds.has(stream.id));
      const selectedAudioStream =
        streams.find((stream) => stream.kind === "audio" && stream.isDefault) ??
        streams.find((stream) => stream.kind === "audio");
      const selectedSubtitleStream =
        streams.find((stream) => stream.kind === "subtitle" && stream.isDefault) ?? null;
      if (selectedAudioStream !== undefined)
        await ipc.command(["set_property", "aid", trackIds.get(selectedAudioStream.id) ?? "no"]);
      await ipc.command([
        "set_property",
        "sid",
        selectedSubtitleStream === null ? "no" : (trackIds.get(selectedSubtitleStream.id) ?? "no"),
      ]);
      await ipc.command(["set_property", "pause", "no"]);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      this.surface.show();
      this.state = {
        sessionId: session.sessionId,
        itemId: session.itemId,
        paused: false,
        positionSeconds: 0,
        durationSeconds: session.durationSeconds,
        volume: 100,
        muted: false,
        ended: false,
        streams,
        selectedAudioStreamId: selectedAudioStream?.id ?? null,
        selectedSubtitleStreamId: selectedSubtitleStream?.id ?? null,
      };
      this.publish();
      return this.sanitized(session);
    } catch (cause) {
      const current = this.active;
      if (current !== null && current.session.sessionId === session.sessionId) {
        await this.stopActive();
      } else {
        if (this.active === null && generation === this.startGeneration) this.surface.hide();
        await this.cleanup({
          session,
          client: input.client,
          process: playerProcess,
          ipc,
          capability,
        });
      }
      throw cause;
    }
  }

  pause(sessionId: string, paused: boolean): IpcPlayerState {
    this.assertActive(sessionId);
    this.state = { ...this.requireState(), paused };
    this.active?.ipc
      .command(["set_property", "pause", paused ? "yes" : "no"])
      .catch((cause: unknown) => this.emitError(cause));
    this.publish();
    return this.requireState();
  }

  seek(sessionId: string, positionSeconds: number): IpcPlayerState {
    this.assertActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
      throw new Error("Invalid position");
    this.active?.ipc
      .command(["seek", positionSeconds, "absolute"])
      .catch((cause: unknown) => this.emitError(cause));
    this.state = { ...this.requireState(), positionSeconds, ended: false };
    this.publish();
    return this.requireState();
  }

  volume(sessionId: string, volume: number, muted = false): IpcPlayerState {
    this.assertActive(sessionId);
    const bounded = Math.max(0, Math.min(100, Math.round(volume)));
    this.active?.ipc
      .command(["set_property", "volume", bounded])
      .catch((cause: unknown) => this.emitError(cause));
    this.active?.ipc
      .command(["set_property", "mute", muted ? "yes" : "no"])
      .catch((cause: unknown) => this.emitError(cause));
    this.state = { ...this.requireState(), volume: bounded, muted };
    this.publish();
    return this.requireState();
  }

  async setSurface(bounds: IpcPlayerSurfaceBounds | null): Promise<void> {
    this.surface.setBounds(bounds);
    if (this.active !== null) this.surface.show();
  }

  async selectAudioStream(sessionId: string, streamId: string): Promise<IpcPlayerState> {
    this.assertActive(sessionId);
    const active = this.active;
    if (active === null) throw new Error("Playback session is not active");
    const state = this.requireState();
    const stream = state.streams.find(
      (candidate) => candidate.id === streamId && candidate.kind === "audio",
    );
    const trackId = stream === undefined ? undefined : active.trackIds.get(streamId);
    if (stream === undefined || trackId === undefined)
      throw new Error("Audio stream is unavailable");
    await active.ipc.command(["set_property", "aid", trackId]);
    this.assertActive(sessionId);
    const currentState = this.requireState();
    this.state = { ...currentState, selectedAudioStreamId: streamId };
    this.publish();
    return this.requireState();
  }

  async selectSubtitleStream(sessionId: string, streamId: string | null): Promise<IpcPlayerState> {
    this.assertActive(sessionId);
    const active = this.active;
    if (active === null) throw new Error("Playback session is not active");
    const state = this.requireState();
    const stream =
      streamId === null
        ? null
        : state.streams.find(
            (candidate) => candidate.id === streamId && candidate.kind === "subtitle",
          );
    const trackId =
      stream === null || stream === undefined ? null : active.trackIds.get(streamId ?? "");
    if (streamId !== null && (stream === undefined || trackId === undefined))
      throw new Error("Subtitle stream is unavailable");
    await active.ipc.command(["set_property", "sid", trackId ?? "no"]);
    this.assertActive(sessionId);
    const currentState = this.requireState();
    this.state = { ...currentState, selectedSubtitleStreamId: stream?.id ?? null };
    this.publish();
    return this.requireState();
  }

  getState(): IpcPlayerState | null {
    return this.state;
  }

  async stop(): Promise<void> {
    this.startGeneration += 1;
    await this.stopActive();
  }

  forceStop(): void {
    this.active?.process.forceStop();
    this.stoppingProcess?.forceStop();
  }

  private stopActive(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const active = this.active;
    this.active = null;
    this.state = null;
    this.surface.hide();
    if (active === null) return Promise.resolve();
    const stopping = this.cleanup(active);
    this.stopping = stopping;
    const clearStopping = (): void => {
      if (this.stopping === stopping) this.stopping = null;
    };
    void stopping.then(clearStopping, clearStopping);
    return stopping;
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
        positionSeconds:
          typeof value === "number" && value >= 0 ? value : this.state.positionSeconds,
        durationSeconds:
          typeof duration === "number" && duration >= 0 ? duration : this.state.durationSeconds,
        paused: paused === true,
        ended: ended === true,
      };
      this.state = next;
      this.publish();
      active.sequence += 1;
      if (active.sequence % 3 === 0) await active.client.heartbeat(next.sessionId, next);
      if (active.sequence % 6 === 0)
        await active.client.progress(next.sessionId, next, active.sequence);
    } catch (cause) {
      // `property unavailable` is expected while no file is loaded (e.g. in
      // the window between spawn and file-loaded); keep the last state and
      // wait for the next tick instead of spamming error listeners.
      if (isPropertyUnavailable(cause)) return;
      this.emitError(cause);
    }
  }

  private async cleanup({
    session,
    client,
    process,
    ipc,
    capability,
  }: PlaybackResources): Promise<void> {
    if (capability !== null) this.bridge.revoke(capability);
    ipc?.close();
    this.stoppingProcess = process;
    await process?.stop();
    this.stoppingProcess = null;
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([client.request(`/api/v1/playback/sessions/${encodeURIComponent(session.sessionId)}`, {
        method: "DELETE",
        signal: abort.signal,
      }), new Promise<void>((resolve) => { timeout = setTimeout(() => { abort.abort(); resolve(); }, 1_000); })]);
    } catch {}
    finally { if (timeout !== null) clearTimeout(timeout); }
  }

  private assertActive(sessionId: string): void {
    if (this.active === null || this.active.session.sessionId !== sessionId)
      throw new Error("Playback session is not active");
  }

  private requireState(): IpcPlayerState {
    if (this.state === null) throw new Error("Playback state is unavailable");
    return this.state;
  }

  private publish(): void {
    if (this.state !== null) this.onState(this.state);
  }

  private emitError(cause: unknown): void {
    // Emitting "error" on an EventEmitter with no "error" listener throws,
    // which previously surfaced as UnhandledPromiseRejectionWarning from the
    // fire-and-forget tick()/pause()/seek()/volume() call sites.
    if (this.listenerCount("error") === 0) return;
    this.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
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
