import { EventEmitter } from "node:events";
import { release } from "node:os";
import {
  describePlayback,
  measuredSize,
  PlaybackDiagnostics,
  PlaybackSessionReporter,
  PlaybackUnavailableError,
  type PlayerBuffer,
  TrackSelectionController,
  type WatchPlaybackSample,
  type WatchPlayer,
} from "@lumen/client";
import type {
  AudioOutput,
  IpcPlayerSurfaceBounds,
  PlaybackInfo,
  PlayerSession,
  PlayerState,
  TrackKind,
} from "@lumen/contracts";
import { app, powerSaveBlocker } from "electron";
import type { ServerClient } from "../api/ServerClient";
import type { MediaStore } from "../media-store/MediaStore";
import { collectAudioDiagnostics } from "./AudioDiagnostics";
import { AudioSettingsStore } from "./AudioSettingsStore";
import type { CompositorSurface } from "./CompositorSurface";
import { mpvBufferedAhead, mpvBufferedRanges } from "./MpvCache";
import { MpvIpc, MpvIpcFailure } from "./MpvIpc";
import {
  isDecoderError,
  MediaDecodeFailure,
  MediaLoadCancelled,
  MpvMediaSource,
  mediaFailure,
} from "./MpvMediaSource";
import { MpvProcess } from "./MpvProcess";
import type { MpvSurface } from "./MpvSurface";
import { sampleMpvPlayback } from "./MpvSynchronization";
import type { PlaybackBridge } from "./PlaybackBridge";
import type { PlaybackClient } from "./PlaybackClient";

export interface PlayerControllerOptions {
  readonly bridge: PlaybackBridge;
  readonly surface: MpvSurface | CompositorSurface;
  readonly onState: (state: PlayerState | null) => void;
  /** Where the viewer's volumes and audio output are kept; forgotten on exit when omitted. */
  readonly audioSettings?: AudioSettingsStore;
  /** Keeps the bytes of what plays; without it every stream is proxied as it arrives. */
  readonly store?: MediaStore;
  /** Told what plays and how far it has got, on the reporting cadence. */
  readonly onProgress?: (playback: {
    readonly connectionId: string;
    readonly state: PlayerState;
  }) => void;
}

interface ActiveSession {
  readonly session: PlayerSession;
  readonly client: PlaybackClient;
  readonly connectionId: string;
  readonly process: MpvProcess;
  readonly ipc: MpvIpc;
  readonly media: MpvMediaSource;
  readonly reporter: PlaybackSessionReporter;
  recovering: boolean;
  selection: TrackSelectionController | null;
  motionRevision: number;
  pendingMotion: number;
  stopping: Promise<void> | null;
  /** False until this session asks MPV for its file; earlier events belong to the file it replaced. */
  loaded: boolean;
  /** Removes what this session listens to on an MPV that outlives it. */
  detach: () => void;
}

interface PlaybackResources {
  readonly reporter: PlaybackSessionReporter;
  readonly process: MpvProcess | null;
  readonly ipc: MpvIpc | null;
  readonly media: MpvMediaSource | null;
}

const AUDIO_RESTART_TIMEOUT_MS = 15_000;
const CACHE_STATE_TIMEOUT_MS = 100;
/** A player slower than this to stop is replaced rather than waited on. */
const HANDOFF_STOP_TIMEOUT_MS = 500;

const sumOfCounts = (...values: ReadonlyArray<unknown>): number | null => {
  const counts = values.filter((value): value is number => typeof value === "number");
  return counts.length === 0 ? null : counts.reduce((total, count) => total + count, 0);
};

const isPropertyUnavailable = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes("property unavailable");

export class PlayerController extends EventEmitter {
  private readonly bridge: PlaybackBridge;
  private readonly surface: MpvSurface | CompositorSurface;
  private readonly onState: (state: PlayerState | null) => void;
  private readonly audioSettings: AudioSettingsStore;
  private readonly store: MediaStore | undefined;
  private readonly onProgress: PlayerControllerOptions["onProgress"];
  private active: ActiveSession | null = null;
  private startingProcess: MpvProcess | null = null;
  private state: PlayerState | null = null;
  private refreshing: ActiveSession | null = null;
  private startGeneration = 0;
  private stopping: Promise<void> | null = null;
  private diagnostics = new PlaybackDiagnostics();
  private diagnosticsItemId: string | null = null;
  private starved = false;
  private intentionalPause = false;
  private lastBufferSampleMs = 0;
  private displaySleepBlocker: number | null = null;

  constructor(options: PlayerControllerOptions) {
    super();
    this.bridge = options.bridge;
    this.surface = options.surface;
    this.onState = options.onState;
    this.audioSettings = options.audioSettings ?? AudioSettingsStore.inMemory();
    this.store = options.store;
    this.onProgress = options.onProgress;
  }

  async start(input: {
    readonly client: PlaybackClient;
    readonly connectionId: string;
    readonly itemId: string;
    /** Resume point; playback starts from the beginning when omitted. */
    readonly startAtSeconds?: number;
    readonly paused?: boolean;
  }): Promise<PlayerSession> {
    const generation = ++this.startGeneration;
    const diagnostics =
      this.diagnosticsItemId === input.itemId ? this.diagnostics : new PlaybackDiagnostics();
    diagnostics.record("playback_requested", {});
    const reused = await this.handOff();
    if (reused === null) await this.stopActive();
    if (generation !== this.startGeneration) {
      await this.releasePlayer(reused, generation);
      throw new Error("Playback was cancelled");
    }
    this.diagnosticsItemId = input.itemId;
    this.diagnostics = diagnostics;
    diagnostics.record("playback_start", {});
    const session = await input.client.startPlayback(input.itemId).catch(async (cause: unknown) => {
      diagnostics.record("playback_failure", { stage: "startup" });
      await this.releasePlayer(reused, generation);
      throw cause;
    });
    diagnostics.record("session_started", {});
    const reporter = new PlaybackSessionReporter(input.client, session.sessionId, (cause) =>
      this.emitError(cause),
    );
    let playerProcess: MpvProcess | null = reused?.process ?? null;
    let ipc: MpvIpc | null = reused?.ipc ?? null;
    let media: MpvMediaSource | null = null;
    let startedActive: ActiveSession | null = null;
    try {
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      if (playerProcess === null || ipc === null) {
        const spawned = MpvProcess.start({
          cwd: process.cwd(),
          resourcesPath: process.resourcesPath,
          videoOutputArguments: this.surface.prepare(),
          onFrame: (frame) => {
            if (this.surface.kind === "compositor") void this.surface.frame(frame);
          },
          onFailure: (error) => {
            if (this.active?.process === spawned) this.failActive(this.active, error);
          },
          onExit: () => {
            if (this.active?.process === spawned)
              this.failActive(this.active, new Error("MPV has exited"));
          },
        });
        playerProcess = spawned;
        this.startingProcess = spawned;
        if (this.surface.kind === "compositor")
          this.surface.connect(spawned, (error) => {
            if (this.active?.process === spawned) this.failActive(this.active, error);
          });
        await spawned.frames?.initialized;
        if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
        const connected = new MpvIpc();
        ipc = connected;
        await connected.connect(spawned);
        connected.on("disconnected", (cause: Error) => {
          if (this.active?.ipc === connected) this.failActive(this.active, cause);
        });
        await connected.command(["request_log_messages", "error"]);
      }
      diagnostics.record("player_ready", { reused: reused !== null });
      if (this.startingProcess === playerProcess) this.startingProcess = null;
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      media = new MpvMediaSource({
        ipc,
        bridge: this.bridge,
        client: input.client,
        session,
        connectionId: input.connectionId,
        diagnostics,
        active: () => this.active?.session === session,
        ...(this.store === undefined ? {} : { store: this.store }),
      });
      const active: ActiveSession = {
        session,
        client: input.client,
        connectionId: input.connectionId,
        process: playerProcess,
        ipc,
        media,
        reporter,
        recovering: false,
        selection: null,
        motionRevision: 0,
        pendingMotion: 0,
        stopping: null,
        loaded: false,
        detach: () => undefined,
      };
      startedActive = active;
      this.active = active;
      const onMediaFailure = (cause: Error) => {
        if (active.media.loading || active.recovering || this.active !== active) return;
        if (active.media.transcoded && this.state?.paused) {
          active.media.suspend();
          return;
        }
        if (
          cause instanceof MediaDecodeFailure &&
          !active.media.transcoded &&
          this.state !== null
        ) {
          void this.recover(active).catch((error) => {
            if (!(error instanceof MediaLoadCancelled)) this.failActive(active, error);
          });
        } else this.failActive(active, cause);
      };
      const onEnd = (event: { reason?: string; file_error?: string }) => {
        if (!active.loaded) return;
        diagnostics.record("media_end", {
          reason: ["eof", "error", "stop", "quit", "redirect"].includes(event.reason ?? "")
            ? (event.reason ?? "unknown")
            : "unknown",
          positionSeconds: this.state?.positionSeconds ?? null,
          loading: active.media.loading,
        });
        if (event.reason === "error")
          onMediaFailure(mediaFailure(event.file_error ?? "Media playback failed"));
        else if (
          event.reason === "eof" &&
          this.active === active &&
          this.state !== null &&
          !active.media.loading
        ) {
          this.state = { ...this.state, ended: true };
          this.publish();
        }
      };
      const onLog = (event: { text?: string }) => {
        if (active.loaded && isDecoderError(event.text ?? ""))
          onMediaFailure(new MediaDecodeFailure("MPV could not decode the media"));
      };
      const sessionIpc = ipc;
      sessionIpc.on("end-file", onEnd);
      sessionIpc.on("log-message", onLog);
      active.detach = () => {
        sessionIpc.off("end-file", onEnd);
        sessionIpc.off("log-message", onLog);
      };
      // MPV keeps what was set for the previous item; a watch group may have changed its speed.
      if (reused !== null) await ipc.command(["set_property", "speed", 1]);
      const { audioOutput } = this.audioSettings.current;
      const { volume, muted } = this.audioSettings.volumeFor(session.titleId ?? null);
      await ipc.command(["set_property", "audio-channels", audioOutput]);
      await ipc.command(["set_property", "volume", volume]);
      await ipc.command(["set_property", "mute", muted ? "yes" : "no"]);
      const startAtSeconds =
        input.startAtSeconds !== undefined &&
        Number.isFinite(input.startAtSeconds) &&
        input.startAtSeconds > 0
          ? input.startAtSeconds
          : 0;
      active.loaded = true;
      await active.media.start(startAtSeconds);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      if (reused === null && process.platform === "darwin" && this.surface.kind === "native") {
        const windowId = await ipc.command(["get_property", "window-id"]);
        if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
        if (typeof windowId !== "number" || !Number.isSafeInteger(windowId) || windowId <= 0) {
          throw new Error("MPV did not create a native video window");
        }
        this.surface.attachNativeWindow(windowId);
      }
      const streams = active.media.streams;
      active.media.paused = input.paused ?? false;
      await ipc.command(["set_property", "pause", input.paused === true ? "yes" : "no"]);
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      await this.surface.show();
      if (generation !== this.startGeneration) throw new Error("Playback was cancelled");
      diagnostics.record("playback_ready", {});
      this.state = {
        sessionId: session.sessionId,
        itemId: session.itemId,
        paused: input.paused ?? false,
        positionSeconds: startAtSeconds,
        durationSeconds: session.durationSeconds,
        bufferedRanges: [],
        volume,
        muted,
        ended: false,
        streams,
        selectedAudioStreamId: active.media.audioId,
        selectedSubtitleStreamId: active.media.subtitleId,
        audioOutput,
      };
      active.selection = new TrackSelectionController({
        sourceId: session.sourceId,
        ...(session.trackMemory === undefined ? {} : { memory: session.trackMemory }),
        get streams() {
          return active.media.streams;
        },
        assertActive: () => {
          if (this.active !== active) throw new Error("Playback session is not active");
        },
        apply: (kind, streamId) => this.applyTrack(active, kind, streamId),
        save: (choice) => active.client.saveTrackChoice(session.sessionId, choice),
        onError: (trackMemoryError) => {
          this.state = { ...this.requireState(), trackMemoryError };
          this.publish();
        },
      });
      this.intentionalPause = input.paused ?? false;
      this.publish();
      return this.sanitized(session);
    } catch (cause) {
      if (this.startingProcess === playerProcess) this.startingProcess = null;
      diagnostics.record(
        generation === this.startGeneration ? "playback_failure" : "playback_cancelled",
        { stage: "startup" },
      );
      if (startedActive !== null) {
        if (this.active === startedActive) await this.stopActive();
        else await startedActive.stopping;
      } else {
        if (this.active === null && generation === this.startGeneration) this.surface.hide();
        await this.cleanup({
          reporter,
          process: playerProcess,
          ipc,
          media,
        });
      }
      throw cause;
    }
  }

  async pause(sessionId: string, paused: boolean): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    active.media.paused = paused;
    if (active.media.loading) {
      this.intentionalPause = paused;
      this.state = { ...this.requireState(), paused };
      this.publish();
      return this.requireState();
    }
    const previous = this.requireState();
    try {
      if (!paused && previous.paused && active.media.transcoded)
        await this.reloadConverted(active, previous.positionSeconds);
      else await this.motion(active, ["set_property", "pause", paused ? "yes" : "no"]);
    } catch (cause) {
      this.emitError(cause);
      throw cause;
    }
    this.assertActive(sessionId);
    const sample = this.state === previous;
    this.intentionalPause = paused;
    this.state = { ...this.requireState(), paused };
    this.publish();
    if (paused) {
      const state = sample
        ? await this.samplePosition(active, this.requireState())
        : this.requireState();
      // The pause already holds; what the server makes of the save is not something to wait on.
      // A session stopped while its position was sampled saves its own final position instead.
      if (this.active === active) void active.reporter.saveProgress(state);
    }
    return this.requireState();
  }

  async seek(sessionId: string, positionSeconds: number): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
      throw new Error("Invalid position");
    this.state = { ...this.requireState(), positionSeconds, ended: false };
    if (active.media.transcoded) await this.reloadConverted(active, positionSeconds);
    else await this.motion(active, ["seek", positionSeconds, "absolute+exact"]);
    this.assertActive(sessionId);
    this.publish();
    return this.requireState();
  }

  async buffer(sessionId: string): Promise<PlayerBuffer> {
    const active = this.requireActive(sessionId);
    if (!active.media.ready) return { aheadSeconds: 0, starved: false, settled: false };
    // Until a seek has finished, the cache still describes the position MPV is leaving.
    if ((await this.command(active, ["get_property", "seeking"])) !== false)
      return { aheadSeconds: 0, starved: false, settled: false };
    const cache = await this.command(active, ["get_property", "demuxer-cache-state"]);
    const starved = (await this.command(active, ["get_property", "paused-for-cache"])) === true;
    // MPV is set to read ahead of playback, paused or not, so it never rests short of that.
    return { aheadSeconds: mpvBufferedAhead(cache), starved, settled: false };
  }

  async speed(sessionId: string, speed: number): Promise<void> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(speed) || speed < 0.9 || speed > 1.1)
      throw new Error("Invalid playback speed");
    await this.motion(active, ["set_property", "speed", speed]);
  }

  volume(sessionId: string, volume: number, muted = false): PlayerState {
    const active = this.requireActive(sessionId);
    const bounded = Math.max(0, Math.min(100, Math.round(volume)));
    this.command(active, ["set_property", "volume", bounded]).catch((cause: unknown) =>
      this.emitError(cause),
    );
    this.command(active, ["set_property", "mute", muted ? "yes" : "no"]).catch((cause: unknown) =>
      this.emitError(cause),
    );
    this.audioSettings.rememberVolume(active.session.titleId ?? null, { volume: bounded, muted });
    this.state = { ...this.requireState(), volume: bounded, muted };
    this.publish();
    return this.requireState();
  }

  async setSurface(bounds: IpcPlayerSurfaceBounds | null): Promise<void> {
    if (bounds === null && this.surface.kind === "compositor") {
      const stopping = this.stop();
      this.surface.setBounds(null);
      await stopping;
      return;
    }
    this.surface.setBounds(bounds);
    if (this.active !== null) await this.surface.show();
  }

  async selectAudioStream(sessionId: string, streamId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (active.selection === null) throw new Error("Playback is starting");
    await active.selection.select("audio", streamId);
    this.assertActive(sessionId);
    return this.requireState();
  }

  async selectSubtitleStream(sessionId: string, streamId: string | null): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (active.selection === null) throw new Error("Playback is starting");
    await active.selection.select("subtitle", streamId);
    this.assertActive(sessionId);
    return this.requireState();
  }

  async resetTrack(sessionId: string, kind: TrackKind): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (active.selection === null) throw new Error("Playback is starting");
    await active.selection.reset(kind);
    this.assertActive(sessionId);
    return this.requireState();
  }

  async retryTrackMemory(sessionId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (active.selection === null) throw new Error("Playback is starting");
    await active.selection.retry();
    this.assertActive(sessionId);
    return this.requireState();
  }

  async dismissTrackMemoryError(sessionId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (active.selection === null) throw new Error("Playback is starting");
    await active.selection.dismissError();
    this.assertActive(sessionId);
    return this.requireState();
  }

  private async applyTrack(
    active: ActiveSession,
    kind: TrackKind,
    streamId: string | null,
  ): Promise<void> {
    const state = this.requireState();
    active.pendingMotion += 1;
    active.motionRevision += 1;
    try {
      await active.media.select(kind, streamId, state.positionSeconds);
      this.assertActive(active.session.sessionId);
      this.state = {
        ...this.requireState(),
        streams: active.media.streams,
        selectedAudioStreamId: active.media.audioId,
        selectedSubtitleStreamId: active.media.subtitleId,
      };
      this.publish();
    } catch (cause) {
      if (!(cause instanceof MediaLoadCancelled)) this.failActive(active, cause);
      throw cause;
    } finally {
      active.pendingMotion -= 1;
      active.motionRevision += 1;
    }
  }

  private async recover(active: ActiveSession): Promise<void> {
    if (active.recovering) return;
    active.recovering = true;
    try {
      const state = this.requireState();
      await this.reloadConverted(active, state.positionSeconds);
    } finally {
      active.recovering = false;
    }
  }

  private async reloadConverted(active: ActiveSession, position: number): Promise<void> {
    active.pendingMotion += 1;
    active.motionRevision += 1;
    try {
      await active.media.convert(position);
      this.assertActive(active.session.sessionId);
      this.state = {
        ...this.requireState(),
        positionSeconds: position,
        bufferedRanges: [],
        streams: active.media.streams,
        selectedAudioStreamId: active.media.audioId,
        selectedSubtitleStreamId: active.media.subtitleId,
      };
      this.publish();
    } catch (cause) {
      if (!(cause instanceof MediaLoadCancelled)) this.failActive(active, cause);
      throw cause;
    } finally {
      active.pendingMotion -= 1;
      active.motionRevision += 1;
    }
  }

  async setAudioOutput(sessionId: string, output: AudioOutput): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const position = await this.command(active, ["get_property", "time-pos"]);
    this.assertActive(sessionId);
    await this.command(active, ["set_property", "audio-channels", output]);
    this.assertActive(sessionId);
    if (active.media.transcoded) {
      await this.reloadConverted(active, this.requireState().positionSeconds);
      this.audioSettings.update({ audioOutput: output });
      this.state = { ...this.requireState(), audioOutput: output };
      this.publish();
      return this.requireState();
    }
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
      }, AUDIO_RESTART_TIMEOUT_MS);
      active.ipc.on("playback-restart", onRestart);
      void this.command(active, [
        "seek",
        typeof position === "number" ? position : this.requireState().positionSeconds,
        "absolute+exact",
      ]).catch((cause: unknown) => {
        cleanup();
        reject(cause);
      });
    });
    this.assertActive(sessionId);
    this.audioSettings.update({ audioOutput: output });
    this.state = { ...this.requireState(), audioOutput: output };
    this.publish();
    return this.requireState();
  }

  playbackTimeline() {
    return this.diagnostics.snapshot();
  }

  async audioDiagnostics(sessionId: string): Promise<string> {
    if (this.active === null || this.state === null)
      return JSON.stringify(
        { lumenVersion: app.getVersion(), playbackTimeline: this.diagnostics.snapshot() },
        null,
        2,
      );
    const active = sessionId === "" ? this.active : this.requireActive(sessionId);
    const state = this.requireState();
    const trackId =
      state.selectedAudioStreamId === null
        ? null
        : active.media.trackIds.get(state.selectedAudioStreamId);
    const diagnostics = this.diagnostics;
    const properties = await collectAudioDiagnostics(active.ipc);
    return JSON.stringify(
      {
        playbackSessionId: active.session.sessionId,
        lumenVersion: app.getVersion(),
        platform: process.platform,
        osRelease: release(),
        audioOutput: state.audioOutput,
        expectedAudioTrack: trackId,
        properties,
        playbackTimeline: diagnostics.snapshot(),
      },
      null,
      2,
    );
  }

  async info(sessionId: string): Promise<PlaybackInfo> {
    const active = this.requireActive(sessionId);
    // MPV has no video to describe until it has decoded some, and asking then is not a failure.
    const property = (name: string): Promise<unknown> =>
      this.command(active, ["get_property", name]).catch(() => null);
    const [version, osdWidth, osdHeight, width, height, outputDrops, decoderDrops] =
      await Promise.all(
        [
          "mpv-version",
          "osd-width",
          "osd-height",
          "width",
          "height",
          "frame-drop-count",
          "decoder-frame-drop-count",
        ].map(property),
      );
    this.assertActive(sessionId);
    return describePlayback(
      active.session,
      active.client.serverOrigin,
      this.state?.selectedAudioStreamId ?? null,
      {
        player: typeof version === "string" ? version : "mpv",
        playerSize: measuredSize(osdWidth, osdHeight),
        videoSize: measuredSize(width, height),
        droppedFrames: sumOfCounts(outputDrops, decoderDrops),
        // MPV drops a frame it cannot decode rather than counting it apart.
        corruptedFrames: null,
      },
    );
  }

  async sample(sessionId: string): Promise<WatchPlaybackSample | null> {
    const active = this.requireActive(sessionId);
    const revision = active.motionRevision;
    if (active.pendingMotion > 0 || !active.media.ready) return null;
    const sample = await sampleMpvPlayback(
      { command: (args) => this.command(active, args) },
      this.requireState(),
    );
    if (sample === null && this.active === active && active.motionRevision === revision) {
      await this.assertMediaLoaded(active);
    }
    return this.active === active &&
      active.motionRevision === revision &&
      active.pendingMotion === 0
      ? sample === null
        ? null
        : { ...sample, positionSeconds: sample.positionSeconds + active.media.offset }
      : null;
  }

  recordSynchronization(fields: Parameters<PlaybackDiagnostics["record"]>[1]): void {
    this.diagnostics.record("watch_synchronization", fields);
  }

  private async motion(active: ActiveSession, args: ReadonlyArray<string | number>): Promise<void> {
    active.motionRevision += 1;
    active.pendingMotion += 1;
    try {
      await this.command(active, args);
      this.assertActive(active.session.sessionId);
    } finally {
      active.motionRevision += 1;
      active.pendingMotion -= 1;
    }
  }

  getState(): PlayerState | null {
    return this.state;
  }

  /** The account and item playing now. */
  nowPlaying(): { readonly connectionId: string; readonly itemId: string } | null {
    return this.active === null
      ? null
      : { connectionId: this.active.connectionId, itemId: this.active.session.itemId };
  }

  getActiveState(sessionId: string): PlayerState {
    this.assertActive(sessionId);
    return this.requireState();
  }

  private failActive(active: ActiveSession, cause: unknown): void {
    if (this.active !== active) return;
    this.diagnostics.record("playback_failure", {
      stage: this.state === null ? "startup" : "runtime",
      sessionId: active.session.sessionId,
    });
    this.startGeneration += 1;
    void this.stopActive();
    this.onState(null);
    this.emitError(cause);
    this.emit("failure", cause instanceof Error ? cause.message : "Playback failed");
  }

  private async command(
    active: ActiveSession,
    args: ReadonlyArray<string | number>,
  ): Promise<unknown> {
    try {
      return await active.ipc.command(args);
    } catch (cause) {
      this.diagnostics.record("mpv_command_failure", {
        command: String(args[0]),
        property: args[0] === "get_property" || args[0] === "set_property" ? String(args[1]) : null,
        transport: cause instanceof MpvIpcFailure,
      });
      if (cause instanceof MpvIpcFailure) this.failActive(active, cause);
      else await this.assertMediaLoaded(active);
      throw cause;
    }
  }

  private async assertMediaLoaded(active: ActiveSession): Promise<void> {
    if (this.active !== active || !active.media.ready || active.pendingMotion > 1) return;
    const revision = active.motionRevision;
    const idle = await active.ipc
      .command(["get_property", "idle-active"], CACHE_STATE_TIMEOUT_MS)
      .catch(() => null);
    if (this.active !== active || !active.media.ready || active.motionRevision !== revision) return;
    if (idle === true) {
      this.diagnostics.record("media_unavailable", { sessionId: active.session.sessionId });
      throw new PlaybackUnavailableError();
    }
  }

  async stop(): Promise<void> {
    this.startGeneration += 1;
    await this.stopActive();
  }

  /**
   * Ends the playing session but keeps its MPV, ready for the next item, so playing on does not
   * wait for a player to quit and another to start. Null when there is no healthy player to keep.
   */
  private async handOff(): Promise<{ readonly process: MpvProcess; readonly ipc: MpvIpc } | null> {
    const active = this.active;
    const state = this.state;
    if (active === null || state === null || this.stopping !== null) return null;
    if (active.process.socketPath === null) return null;
    this.active = null;
    this.state = null;
    this.syncDisplaySleepBlocker();
    this.starved = false;
    this.intentionalPause = false;
    this.startingProcess = active.process;
    active.reporter.retire();
    active.detach();
    const savedState = await this.samplePosition(active, state);
    const stopped = await active.ipc.command(["stop"], HANDOFF_STOP_TIMEOUT_MS).then(
      () => true,
      () => false,
    );
    active.media.close();
    const finishing = this.finishSession(active, savedState).catch((cause: unknown) =>
      this.emitError(cause),
    );
    active.stopping = finishing;
    if (stopped && this.startingProcess === active.process)
      return { process: active.process, ipc: active.ipc };
    if (this.startingProcess === active.process) this.startingProcess = null;
    active.ipc.close();
    await active.process.stop().catch((cause: unknown) => this.emitError(cause));
    return null;
  }

  /** Stops a kept MPV that no session took over. */
  private async releasePlayer(
    player: { readonly process: MpvProcess; readonly ipc: MpvIpc } | null,
    generation: number,
  ): Promise<void> {
    if (player === null) return;
    if (this.startingProcess === player.process) this.startingProcess = null;
    if (this.active === null && generation === this.startGeneration) this.surface.hide();
    player.ipc.close();
    await player.process.stop().catch((cause: unknown) => this.emitError(cause));
  }

  /** Records where a session ended and closes it on the server. */
  private async finishSession(
    active: ActiveSession,
    savedState: PlayerState | null,
  ): Promise<void> {
    // Where playback ended counts too: watching to the end may stop before the next report.
    if (savedState !== null) {
      this.onProgress?.({ connectionId: active.connectionId, state: savedState });
      await active.reporter.saveProgress(savedState);
    }
    await active.reporter.end();
  }

  private stopActive(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const active = this.active;
    const starting = this.startingProcess;
    this.startingProcess = null;
    const state = this.state;
    this.active = null;
    this.state = null;
    this.syncDisplaySleepBlocker();
    this.starved = false;
    this.intentionalPause = false;
    active?.reporter.retire();
    active?.media.close();
    this.surface.hide();
    const stopping =
      active === null
        ? (starting?.stop() ?? Promise.resolve())
        : this.cleanup(active, state === null ? null : { active, state });
    if (active !== null) active.stopping = stopping;
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
    if (
      active === null ||
      state === null ||
      this.refreshing === active ||
      !active.media.ready ||
      active.pendingMotion > 0
    )
      return;
    const revision = active.motionRevision;
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
      const [seeking, pausedForCache] = await Promise.all([
        active.ipc.command(["get_property", "seeking"], CACHE_STATE_TIMEOUT_MS).catch(() => null),
        active.ipc
          .command(["get_property", "paused-for-cache"], CACHE_STATE_TIMEOUT_MS)
          .catch(() => null),
      ]);
      // A stop, replacement session, or user action makes this sample stale.
      if (
        this.active !== active ||
        this.state !== state ||
        !active.media.ready ||
        active.motionRevision !== revision
      )
        return;
      let next: PlayerState = {
        ...state,
        positionSeconds:
          typeof value === "number" && value >= 0
            ? value + active.media.offset
            : state.positionSeconds,
        durationSeconds: active.media.transcoded
          ? active.session.durationSeconds
          : typeof duration === "number" && duration >= 0
            ? duration
            : state.durationSeconds,
        bufferedRanges:
          mpvBufferedRanges(cache)?.map((range) => ({
            startSeconds: range.startSeconds + active.media.offset,
            endSeconds: range.endSeconds + active.media.offset,
          })) ?? state.bufferedRanges,
        paused: paused === true,
        ended: ended === true,
        downloadedRanges: this.downloadedRanges(active, state.durationSeconds),
      };
      if (seeking !== null && pausedForCache !== null) {
        // A seek waits on data just as a drained cache does, so the viewer sees both as buffering.
        next = {
          ...next,
          buffering:
            (pausedForCache === true || seeking === true) &&
            ended !== true &&
            !this.intentionalPause,
        };
        const starved =
          pausedForCache === true && seeking !== true && ended !== true && !this.intentionalPause;
        const now = Date.now();
        if (starved !== this.starved || now - this.lastBufferSampleMs >= 1000) {
          this.diagnostics.record(
            starved !== this.starved
              ? starved
                ? "buffer_starvation"
                : "buffer_recovery"
              : "buffer_sample",
            {
              sessionId: active.session.sessionId,
              aheadSeconds: Number.isFinite(mpvBufferedAhead(cache))
                ? mpvBufferedAhead(cache)
                : null,
              pausedForCache: pausedForCache === true,
              seeking: seeking === true,
              intentionalPause: this.intentionalPause,
              eof: ended === true,
              positionSeconds: next.positionSeconds,
            },
          );
          this.lastBufferSampleMs = now;
        }
        this.starved = starved;
      }
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
    if (this.active === null || this.state === null) return;
    this.onProgress?.({ connectionId: this.active.connectionId, state: this.state });
    await this.active.reporter.tick(this.state);
  }

  /** What of a downloaded file is on this device, as stretches of its timeline. */
  private downloadedRanges(
    active: ActiveSession,
    durationSeconds: number | null,
  ): PlayerState["downloadedRanges"] {
    const file = active.media.heldFile;
    if (file === null || file.pins === 0 || durationSeconds === null || durationSeconds <= 0)
      return [];
    // Bytes map to time only on average; it is close enough to show what is downloaded.
    const secondsPerByte = durationSeconds / file.spec.sizeBytes;
    return file.heldRanges().map(([start, end]) => ({
      startSeconds: start * secondsPerByte,
      endSeconds: end * secondsPerByte,
    }));
  }

  private async samplePosition(active: ActiveSession, state: PlayerState): Promise<PlayerState> {
    if (!active.media.ready) return state;
    let positionSeconds = state.positionSeconds;
    try {
      const position = await active.ipc.command(["get_property", "time-pos"], 150);
      if (typeof position === "number" && Number.isFinite(position) && position >= 0)
        positionSeconds = position + active.media.offset;
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
    const { reporter, process, ipc, media } = resources;
    reporter.retire();
    media?.close();
    const savedState =
      finalProgress === null
        ? null
        : await this.samplePosition(finalProgress.active, finalProgress.state);
    ipc?.close();
    const stoppingProcess = process?.stop().catch((cause: unknown) => this.emitError(cause));
    const finishing =
      finalProgress === null
        ? reporter.end()
        : this.finishSession(finalProgress.active, savedState);
    await Promise.all([stoppingProcess, finishing]);
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

  private syncDisplaySleepBlocker(): void {
    const playing = this.state !== null && !this.state.paused && !this.state.ended;
    if (playing && this.displaySleepBlocker === null) {
      this.displaySleepBlocker = powerSaveBlocker.start("prevent-display-sleep");
    } else if (!playing && this.displaySleepBlocker !== null) {
      powerSaveBlocker.stop(this.displaySleepBlocker);
      this.displaySleepBlocker = null;
    }
  }

  private publish(): void {
    this.syncDisplaySleepBlocker();
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
  sample: (sessionId) => controller.sample(sessionId),
  recordSynchronization: (fields) => controller.recordSynchronization(fields),
  seek: (sessionId, positionSeconds) => controller.seek(sessionId, positionSeconds),
  pause: (sessionId, paused) => controller.pause(sessionId, paused),
  speed: (sessionId, speed) => controller.speed(sessionId, speed),
  buffer: (sessionId) => controller.buffer(sessionId),
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
