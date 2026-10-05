import { EventEmitter } from "node:events";
import { release } from "node:os";
import type {
  AudioOutput,
  BufferedRange,
  PlayerSession,
  PlayerState,
  IpcPlayerSurfaceBounds,
} from "@lumen/contracts";
import { PlaybackSessionReporter, type WatchPlayer } from "@lumen/client";
import { app } from "electron";
import type { ServerClient } from "../api/ServerClient";
import { collectAudioDiagnostics } from "./AudioDiagnostics";
import { MpvIpc, MpvIpcFailure } from "./MpvIpc";
import { MpvProcess } from "./MpvProcess";
import type { MpvSurface } from "./MpvSurface";
import type { PlaybackBridge } from "./PlaybackBridge";

export interface PlayerControllerOptions {
  readonly bridge: PlaybackBridge;
  readonly surface: MpvSurface;
  readonly onState: (state: PlayerState) => void;
}

interface MpvTrack {
  readonly id: number;
  readonly type: "audio" | "sub";
  readonly "ff-index"?: number;
}

const bufferedRangesFrom = (value: unknown): ReadonlyArray<BufferedRange> => {
  if (value === null || typeof value !== "object" || !("seekable-ranges" in value)) return [];
  const ranges = value["seekable-ranges"];
  if (!Array.isArray(ranges)) return [];
  return ranges.flatMap((range: unknown) => {
    if (range === null || typeof range !== "object" || !("start" in range) || !("end" in range))
      return [];
    const { start, end } = range;
    return typeof start === "number" && Number.isFinite(start) && start >= 0 &&
        typeof end === "number" && Number.isFinite(end) && end > start
      ? [{ startSeconds: start, endSeconds: end }]
      : [];
  });
};

interface ActiveSession {
  readonly session: PlayerSession;
  readonly client: ServerClient;
  readonly connectionId: string;
  readonly process: MpvProcess;
  readonly ipc: MpvIpc;
  readonly capability: string;
  readonly cancellation: AbortController;
  readonly reporter: PlaybackSessionReporter;
  trackIds: ReadonlyMap<string, number>;
  stopping: Promise<void> | null;
}

interface PlaybackResources {
  readonly reporter: PlaybackSessionReporter;
  readonly process: MpvProcess | null;
  readonly ipc: MpvIpc | null;
  readonly capability: string | null;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const FILE_LOADED_TIMEOUT_MS = 15_000;
const CACHE_STATE_TIMEOUT_MS = 100;

const isPropertyUnavailable = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes("property unavailable");

const resolveTrackIds = async (
  ipc: MpvIpc,
  streams: PlayerSession["streams"],
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
  private readonly onState: (state: PlayerState) => void;
  private active: ActiveSession | null = null;
  private state: PlayerState | null = null;
  private refreshing: ActiveSession | null = null;
  private startGeneration = 0;
  private stopping: Promise<void> | null = null;
  // Avoid relying on a Windows driver to downmix center/surround channels.
  // Automatic output remains available for a correctly configured surround system.
  private audioOutput: AudioOutput = process.platform === "win32" ? "stereo" : "auto-safe";

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
    /** Resume point; playback starts from the beginning when omitted. */
    readonly startAtSeconds?: number;
    readonly paused?: boolean;
  }): Promise<PlayerSession> {
    const generation = ++this.startGeneration;
    await this.stopActive();
    if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
    const session = await input.client.startPlayback(input.itemId);
    const reporter = new PlaybackSessionReporter(input.client, session.sessionId, (cause) =>
      this.emitError(cause),
    );
    let playerProcess: MpvProcess | null = null;
    let ipc: MpvIpc | null = null;
    let capability: string | null = null;
    let startedActive: ActiveSession | null = null;
    try {
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      playerProcess = MpvProcess.start({
        cwd: process.cwd(),
        resourcesPath: process.resourcesPath,
        videoOutputArguments: this.surface.prepare(),
        onExit: () => {
          const active = this.active;
          if (active?.process === playerProcess && active?.session === session)
            this.failActive(active, new Error("MPV has exited"));
        },
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
        cancellation: new AbortController(),
        reporter,
        trackIds: new Map(),
        stopping: null,
      };
      startedActive = active;
      this.active = active;
      ipc.on("disconnected", (cause: Error) => this.failActive(active, cause));
      ipc.on("end-file", (event: { readonly reason?: string; readonly file_error?: string }) => {
        if (event.reason === "error")
          this.failActive(active, new Error(`Playback failed: ${event.file_error ?? "media error"}`));
      });
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
        const onEnded = (cause: unknown): void => {
          detachLoadListeners();
          reject(cause instanceof Error ? cause : new Error("MPV has exited"));
        };
        const onLoaded = (): void => {
          detachLoadListeners();
          resolve();
        };
        const onCancelled = (): void => onEnded(active.cancellation.signal.reason);
        detachLoadListeners = (): void => {
          clearTimeout(timer);
          active.cancellation.signal.removeEventListener("abort", onCancelled);
          mpv.off("file-loaded", onLoaded);
        };
        active.cancellation.signal.addEventListener("abort", onCancelled, { once: true });
        mpv.on("file-loaded", onLoaded);
      });
      void loaded.catch(() => undefined);
      try {
        await ipc.command(["set_property", "audio-channels", this.audioOutput]);
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
      active.trackIds = trackIds;
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
      // Seek while still paused so the first frame shown is the resume point.
      const startAtSeconds =
        input.startAtSeconds !== undefined &&
        Number.isFinite(input.startAtSeconds) &&
        input.startAtSeconds > 0
          ? input.startAtSeconds
          : 0;
      if (startAtSeconds > 0) await ipc.command(["seek", startAtSeconds, "absolute"]);
      await ipc.command(["set_property", "pause", input.paused === true ? "yes" : "no"]);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      this.surface.show();
      this.state = {
        sessionId: session.sessionId,
        itemId: session.itemId,
        paused: input.paused ?? false,
        positionSeconds: startAtSeconds,
        durationSeconds: session.durationSeconds,
        bufferedRanges: [],
        volume: 100,
        muted: false,
        ended: false,
        streams,
        selectedAudioStreamId: selectedAudioStream?.id ?? null,
        selectedSubtitleStreamId: selectedSubtitleStream?.id ?? null,
        audioOutput: this.audioOutput,
      };
      this.publish();
      return this.sanitized(session);
    } catch (cause) {
      if (startedActive !== null) {
        if (this.active === startedActive) await this.stopActive();
        else await startedActive.stopping;
      } else {
        if (this.active === null && generation === this.startGeneration) this.surface.hide();
        await this.cleanup({
          reporter,
          process: playerProcess,
          ipc,
          capability,
        });
      }
      throw cause;
    }
  }

  async pause(sessionId: string, paused: boolean): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const previous = this.requireState();
    try {
      await this.command(active, ["set_property", "pause", paused ? "yes" : "no"]);
    } catch (cause) {
      this.emitError(cause);
      throw cause;
    }
    this.assertActive(sessionId);
    const sample = this.state === previous;
    this.state = { ...this.requireState(), paused };
    this.publish();
    if (paused) {
      const state = sample ? await this.samplePosition(active, this.requireState()) : this.requireState();
      await active.reporter.saveProgress(state);
    }
    return this.requireState();
  }

  async seek(sessionId: string, positionSeconds: number): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
      throw new Error("Invalid position");
    this.state = { ...this.requireState(), positionSeconds, ended: false };
    await this.command(active, ["seek", positionSeconds, "absolute+exact"]);
    this.assertActive(sessionId);
    this.publish();
    return this.requireState();
  }

  /** Whether MPV has finished moving to its current position, as after a seek. */
  async loaded(sessionId: string): Promise<boolean> {
    const active = this.requireActive(sessionId);
    return (await this.command(active, ["get_property", "seeking"])) === false;
  }

  async speed(sessionId: string, speed: number): Promise<void> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(speed) || speed < 0.9 || speed > 1.1) throw new Error("Invalid playback speed");
    await this.command(active, ["set_property", "speed", speed]);
  }

  volume(sessionId: string, volume: number, muted = false): PlayerState {
    const active = this.requireActive(sessionId);
    const bounded = Math.max(0, Math.min(100, Math.round(volume)));
    this.command(active, ["set_property", "volume", bounded])
      .catch((cause: unknown) => this.emitError(cause));
    this.command(active, ["set_property", "mute", muted ? "yes" : "no"])
      .catch((cause: unknown) => this.emitError(cause));
    this.state = { ...this.requireState(), volume: bounded, muted };
    this.publish();
    return this.requireState();
  }

  async setSurface(bounds: IpcPlayerSurfaceBounds | null): Promise<void> {
    this.surface.setBounds(bounds);
    if (this.active !== null) this.surface.show();
  }

  async selectAudioStream(sessionId: string, streamId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const state = this.requireState();
    const stream = state.streams.find(
      (candidate) => candidate.id === streamId && candidate.kind === "audio",
    );
    const trackId = stream === undefined ? undefined : active.trackIds.get(streamId);
    if (stream === undefined || trackId === undefined)
      throw new Error("Audio stream is unavailable");
    await this.command(active, ["set_property", "aid", trackId]);
    this.assertActive(sessionId);
    const currentState = this.requireState();
    this.state = { ...currentState, selectedAudioStreamId: streamId };
    this.publish();
    return this.requireState();
  }

  async selectSubtitleStream(sessionId: string, streamId: string | null): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
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
    await this.command(active, ["set_property", "sid", trackId ?? "no"]);
    this.assertActive(sessionId);
    const currentState = this.requireState();
    this.state = { ...currentState, selectedSubtitleStreamId: stream?.id ?? null };
    this.publish();
    return this.requireState();
  }

  async setAudioOutput(sessionId: string, output: AudioOutput): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const position = await this.command(active, ["get_property", "time-pos"]);
    this.assertActive(sessionId);
    await this.command(active, ["set_property", "audio-channels", output]);
    this.assertActive(sessionId);
    // MPV rebuilds the audio filter/output asynchronously. A second change
    // during an outstanding seek can leave it without output. Explicitly
    // restart at the current position, preserving pause and track selection,
    // and wait for the restart before accepting another change from the UI.
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        active.ipc.off("playback-restart", onRestart);
      };
      const onRestart = (): void => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out restarting audio output"));
      }, FILE_LOADED_TIMEOUT_MS);
      active.ipc.on("playback-restart", onRestart);
      void this.command(active, [
          "seek",
          typeof position === "number" ? position : this.requireState().positionSeconds,
          "absolute+exact",
        ])
        .catch((cause: unknown) => {
          cleanup();
          reject(cause);
        });
    });
    this.assertActive(sessionId);
    this.audioOutput = output;
    this.state = { ...this.requireState(), audioOutput: output };
    this.publish();
    return this.requireState();
  }

  async audioDiagnostics(sessionId: string): Promise<string> {
    const active = this.requireActive(sessionId);
    const state = this.requireState();
    const trackId =
      state.selectedAudioStreamId === null
        ? null
        : active.trackIds.get(state.selectedAudioStreamId);
    const properties = await collectAudioDiagnostics(active.ipc);
    this.assertActive(sessionId);
    return JSON.stringify(
      {
        lumenVersion: app.getVersion(),
        platform: process.platform,
        osRelease: release(),
        audioOutput: state.audioOutput,
        expectedAudioTrack: trackId,
        properties,
      },
      null,
      2,
    );
  }

  getState(): PlayerState | null {
    return this.state;
  }

  getActiveState(sessionId: string): PlayerState {
    this.assertActive(sessionId);
    return this.requireState();
  }

  private failActive(active: ActiveSession, cause: unknown): void {
    if (this.active !== active) return;
    this.startGeneration += 1;
    void this.stopActive(cause);
    this.emitError(cause);
    this.emit("ended", cause);
  }

  private async command(active: ActiveSession, args: ReadonlyArray<string | number>): Promise<unknown> {
    try {
      return await active.ipc.command(args);
    } catch (cause) {
      if (cause instanceof MpvIpcFailure) this.failActive(active, cause);
      throw cause;
    }
  }

  async stop(): Promise<void> {
    this.startGeneration += 1;
    await this.stopActive();
  }

  private stopActive(cause: unknown = new Error("Playback was cancelled")): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const active = this.active;
    const state = this.state;
    this.active = null;
    this.state = null;
    active?.reporter.retire();
    active?.cancellation.abort(cause);
    this.surface.hide();
    if (active === null) return Promise.resolve();
    const stopping = this.cleanup(active, state === null ? null : { active, state });
    active.stopping = stopping;
    this.stopping = stopping;
    const clearStopping = (): void => {
      if (this.stopping === stopping) this.stopping = null;
    };
    void stopping.then(clearStopping, clearStopping);
    return stopping;
  }

  async refreshState(): Promise<void> {
    const active = this.active;
    const state = this.state;
    if (active === null || state === null || this.refreshing === active) return;
    this.refreshing = active;
    try {
      const cacheState = active.ipc
        .command(["get_property", "demuxer-cache-state"], CACHE_STATE_TIMEOUT_MS)
        .catch(() => null);
      const value = await this.command(active, ["get_property", "time-pos"]);
      const duration = await this.command(active, ["get_property", "duration"]);
      const paused = await this.command(active, ["get_property", "pause"]);
      const ended = await this.command(active, ["get_property", "eof-reached"]);
      const cache = await cacheState;
      // A stop, replacement session, or user action makes this sample stale.
      if (this.active !== active || this.state !== state) return;
      const next: PlayerState = {
        ...state,
        positionSeconds:
          typeof value === "number" && value >= 0 ? value : state.positionSeconds,
        durationSeconds:
          typeof duration === "number" && duration >= 0 ? duration : state.durationSeconds,
        bufferedRanges: bufferedRangesFrom(cache),
        paused: paused === true,
        ended: ended === true,
      };
      this.state = next;
      this.publish();
    } catch (cause) {
      // `property unavailable` is expected while no file is loaded (e.g. in
      // the window between spawn and file-loaded); keep the last state and
      // wait for the next tick instead of spamming error listeners.
      if (this.active !== active || isPropertyUnavailable(cause)) return;
      this.emitError(cause);
    } finally {
      if (this.refreshing === active) this.refreshing = null;
    }
  }

  /** Reports the session to the server on the slower heartbeat / saved-progress cadence. */
  async tick(): Promise<void> {
    if (this.active !== null && this.state !== null) await this.active.reporter.tick(this.state);
  }

  private async samplePosition(active: ActiveSession, state: PlayerState): Promise<PlayerState> {
    let positionSeconds = state.positionSeconds;
    try {
      const position = await active.ipc.command(["get_property", "time-pos"], 150);
      if (typeof position === "number" && Number.isFinite(position) && position >= 0)
        positionSeconds = position;
    } catch {
      // The last sampled position is still useful if MPV is already closing.
    }
    if (state.durationSeconds !== null)
      positionSeconds = Math.min(positionSeconds, state.durationSeconds);
    if (this.active === active && this.state === state) {
      this.state = { ...this.state, positionSeconds };
      this.publish();
    }
    return { ...state, positionSeconds };
  }

  private async cleanup(
    resources: PlaybackResources,
    finalProgress: { readonly active: ActiveSession; readonly state: PlayerState } | null = null,
  ): Promise<void> {
    const { reporter, process, ipc, capability } = resources;
    reporter.retire();
    const savedState = finalProgress === null
      ? null
      : await this.samplePosition(finalProgress.active, finalProgress.state);
    if (capability !== null) this.bridge.revoke(capability);
    ipc?.close();
    const stoppingProcess = process?.stop().catch((cause: unknown) => this.emitError(cause));
    if (savedState !== null) await reporter.saveProgress(savedState);
    await stoppingProcess;
    await reporter.end();
  }

  private requireActive(sessionId: string): ActiveSession {
    if (this.active === null || this.active.session.sessionId !== sessionId)
      throw new Error("Playback session is not active");
    return this.active;
  }

  private assertActive(sessionId: string): void {
    this.requireActive(sessionId);
  }

  private requireState(): PlayerState {
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

  private sanitized(session: PlayerSession): PlayerSession {
    const { grantToken: _grantToken, ...safe } = session;
    return safe as PlayerState & PlayerSession;
  }
}

/** The native player as watch groups drive it. */
export const watchPlayerFor = (controller: PlayerController): WatchPlayer<ServerClient> => ({
  start: ({ server, ...input }) => controller.start({ client: server, ...input }),
  stop: () => controller.stop(),
  getState: () => controller.getState(),
  seek: (sessionId, positionSeconds) => controller.seek(sessionId, positionSeconds),
  pause: (sessionId, paused) => controller.pause(sessionId, paused),
  speed: (sessionId, speed) => controller.speed(sessionId, speed),
  loaded: (sessionId) => controller.loaded(sessionId),
});

export const startNativePlayer = (controller: PlayerController): (() => void) => {
  // UI sampling is independent of the slower heartbeat / saved-progress cadence.
  const refreshTimer = setInterval(() => void controller.refreshState(), 250);
  const reportTimer = setInterval(() => void controller.tick(), 3_000);
  refreshTimer.unref();
  reportTimer.unref();
  return () => {
    clearInterval(refreshTimer);
    clearInterval(reportTimer);
  };
};
