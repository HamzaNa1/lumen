import {
  describePlayback,
  measuredSize,
  OriginalReturn,
  originalFits,
  originalKbps,
  originalStalled,
  PLAYBACK_REPORT_INTERVAL_MS,
  PlaybackDiagnostics,
  type PlaybackSessionApi,
  PlaybackSessionReporter,
  PlaybackUnsupportedError,
  type PlayerBuffer,
  qualityState,
  RETURN_TO_ORIGINAL,
  rememberedThroughput,
  rememberThroughput,
  ServerHttpError,
  setTranscodingParameters,
  shouldLeaveOriginal,
  startingRendition,
  ThroughputEstimator,
  TrackSelectionController,
  type WatchPlaybackSample,
} from "@lumen/client";
import type {
  AdaptiveRendition,
  PlayableStream,
  PlaybackInfo,
  PlayerSession,
  PlayerState,
  VolumeMemory,
} from "@lumen/contracts";
import {
  adaptiveRenditionsFor,
  DEFAULT_TRACK_PREFERENCES,
  rememberTitleVolume,
  resolveTrackSelection,
  type TrackChoiceInput,
  type TrackKind,
  type TrackMemory,
  type TrackPreferences,
  volumeForTitle,
} from "@lumen/contracts";
import { AdaptiveSource, adaptivePlaybackSupported } from "./AdaptiveSource";
import {
  audioCodecProbe,
  fallbackTranscodingPlan,
  selectedAudio,
  type TranscodingPlan,
  transcodingPlan,
} from "./TranscodingPlan";

/** The parts of an HTML media element the player drives. */
export interface MediaElementLike {
  src: string;
  currentTime: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly networkState: number;
  readonly error: { readonly code: number } | null;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
  };
  /** Present on video elements only. */
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  getVideoPlaybackQuality?(): {
    readonly droppedVideoFrames: number;
    readonly corruptedVideoFrames?: number;
  };
  /** Only some browsers let a page switch between a file's audio tracks. */
  readonly audioTracks?: { readonly length: number; [index: number]: { enabled: boolean } };
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  canPlayType(type: string): string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface BrowserPlaybackApi {
  readonly serverOrigin: string;
  /** Whether the server converts into pieces of several qualities; older servers do not. */
  readonly supportsAdaptive?: boolean;
  readonly saveTrackChoice: (
    sessionId: string,
    input: TrackChoiceInput,
  ) => Promise<TrackMemory | null>;
  readonly startPlayback: (itemId: string) => Promise<PlayerSession>;
  readonly heartbeat: (sessionId: string, state: PlayerState) => Promise<void>;
  readonly progress: (
    sessionId: string,
    state: PlayerState,
    sequence: number,
    init?: { readonly keepalive?: boolean; readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly stopPlayback: (
    sessionId: string,
    init?: { readonly keepalive?: boolean },
  ) => Promise<void>;
}

export interface VolumeMemoryStorage {
  /** Null when the viewer has not set a volume here, or it cannot be read. */
  readonly read: () => VolumeMemory | null;
  readonly write: (memory: VolumeMemory) => void;
}

export interface HtmlMediaPlayerOptions {
  readonly element: MediaElementLike;
  readonly api: BrowserPlaybackApi;
  readonly onState: (state: PlayerState | null) => void;
  /** Playback that had started can no longer continue. */
  readonly onFailure: (cause: Error) => void;
  /** Where the viewer's volumes are kept; forgotten with the page when omitted. */
  readonly volumeMemory?: VolumeMemoryStorage;
  readonly loadTimeoutMs?: number;
  /** How long a command waits for the browser to answer a request to play. */
  readonly playAnswerTimeoutMs?: number;
}

interface ActiveSession {
  readonly session: PlayerSession;
  readonly reporter: PlaybackSessionReporter;
  readonly streams: ReadonlyArray<PlayableStream>;
  /** Detaches the element's listeners and the report timer. */
  detach: () => void;
  selectedAudioStreamId: string | null;
  selection: TrackSelectionController | null;
  trackMemoryError: string | null;
  trackPreferences: TrackPreferences;
  buffering: boolean;
  awaitingInteraction: boolean;
  /** A request to play that the browser is holding, having neither started nor refused it. */
  heldPlay: Promise<void> | null;
  /** The page was hidden and the server session ended; it must be reopened before resuming. */
  suspended: boolean;
  /** Whether playback was running when the page was hidden. */
  playingBeforeSuspend: boolean;
  suspendedPositionSeconds: number | null;
  desiredPaused: boolean;
  replacingSource: boolean;
  /** Qualities the server converts this file into; empty where adaptive playback is unavailable. */
  renditions: ReadonlyArray<AdaptiveRendition>;
  /** "auto", "original", or a rendition id. */
  qualityChoice: string;
  readonly originalKbps: number | null;
  /** Whether Auto may pick the original: it plays as it is, or with only its audio converted. */
  readonly originalUsable: boolean;
  readonly originalReturn: OriginalReturn;
  /** Where the buffer ended at the last connection sample while the original played. */
  lastBufferSample: { readonly atMs: number; readonly endSeconds: number } | null;
  /** When playback ran dry outside a seek; null while it has data. */
  starvedSinceMs: number | null;
}

const LOAD_TIMEOUT_MS = 20_000;
// A browser that will start or refuse playback says so at once. One that takes longer is holding
// the request: until it has media to play, or until a page opened in the background is first shown.
const PLAY_ANSWER_TIMEOUT_MS = 1000;
const MAX_RECOVERIES = 2;
const RECOVERY_WINDOW_MS = 60_000;

// HTMLMediaElement.readyState: decoded data at the current position, or enough to advance.
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
// HTMLMediaElement.networkState: the browser has a source and is not fetching any of it just now.
const NETWORK_IDLE = 1;
// What a browser has buffered can stop a little short of the duration it reports.
const END_TOLERANCE_SECONDS = 0.5;

// MediaError.code
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const UNSUPPORTED_FORMAT =
  "This browser can’t play this file’s format. Try another browser or the Lumen desktop app.";

const cancelled = (): Error => new Error("Playback was cancelled");

const inactive = (): Error => new Error("Playback session is not active");

const isAbort = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError";

const describeMediaError = (code: number | undefined): Error =>
  code === MEDIA_ERR_SRC_NOT_SUPPORTED || code === MEDIA_ERR_DECODE
    ? new PlaybackUnsupportedError(UNSUPPORTED_FORMAT)
    : code === MEDIA_ERR_NETWORK
      ? new Error("The connection was lost while loading this file.")
      : new Error("This file could not be played.");

/**
 * Plays media in an HTML media element, with the server's playback session kept alongside it.
 *
 * The element is the source of truth for what the viewer sees: state is read from it rather than
 * assumed, so a `play()` the browser refuses, or playback it stalls, shows up as it really is.
 * Every asynchronous step checks that it still belongs to the latest `start` or `stop`, so a
 * session replaced during rapid navigation can never report into its successor.
 */
export class HtmlMediaPlayer {
  private readonly element: MediaElementLike;
  private readonly api: BrowserPlaybackApi;
  private readonly onState: (state: PlayerState | null) => void;
  private readonly onFailure: (cause: Error) => void;
  private readonly volumeMemory: VolumeMemoryStorage | null;
  private readonly loadTimeoutMs: number;
  private readonly playAnswerTimeoutMs: number;
  private active: ActiveSession | null = null;
  private conversion: TranscodingPlan | null = null;
  /** Set while converted pieces play; the original file plays otherwise. */
  private adaptive: AdaptiveSource | null = null;
  /** What the next load plays: the original, or converted pieces starting in this quality. */
  private nextAdaptive: AdaptiveRendition | null = null;
  private estimator = new ThroughputEstimator();
  /** The quality choice of a session being opened, before it is the active one. */
  private openingChoice = "auto";
  /** The audio track converted pieces carry, as its position among the file's audio tracks. */
  private adaptiveAudioIndex = 0;
  private timeOffset = 0;
  private forceConversion = false;
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private recoveries: number[] = [];
  private leaving = false;
  private diagnostics = new PlaybackDiagnostics();

  playbackDiagnostics(): string {
    return JSON.stringify(
      { httpStatusAvailable: false, playbackTimeline: this.diagnostics.snapshot() },
      null,
      2,
    );
  }

  constructor(options: HtmlMediaPlayerOptions) {
    this.element = options.element;
    this.api = options.api;
    this.onState = options.onState;
    this.onFailure = options.onFailure;
    this.volumeMemory = options.volumeMemory ?? null;
    this.loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.playAnswerTimeoutMs = options.playAnswerTimeoutMs ?? PLAY_ANSWER_TIMEOUT_MS;
  }

  async start(input: {
    readonly itemId: string;
    /** Resume point; playback starts from the beginning when omitted. */
    readonly startAtSeconds?: number;
    readonly paused?: boolean;
  }): Promise<void> {
    const generation = ++this.generation;
    await this.stopActive();
    if (generation !== this.generation) throw cancelled();
    this.recoveries = [];
    this.forceConversion = false;
    this.estimator = new ThroughputEstimator(rememberedThroughput(this.api.serverOrigin));
    const diagnostics = new PlaybackDiagnostics();
    this.diagnostics = diagnostics;
    try {
      await this.open(generation, input.itemId, input.startAtSeconds ?? 0, input.paused === true);
    } catch (cause) {
      diagnostics.record(generation === this.generation ? "browser_failure" : "browser_cancelled", {
        stage: "startup",
        mediaErrorCode: this.element.error?.code ?? null,
      });
      throw cause;
    }
  }

  async pause(sessionId: string, paused: boolean): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    active.desiredPaused = paused;
    if (paused) {
      this.element.pause();
      // The pause already holds; what the server makes of the save is not something to wait on.
      void active.reporter.saveProgress(this.snapshot(active));
    } else if (!active.replacingSource) await this.play(active);
    return this.publishIfActive(active);
  }

  async seek(sessionId: string, positionSeconds: number): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
      throw new Error("Invalid position");
    // A seek interrupts playback anyway, so it is where Auto returns to the original for free.
    if (
      this.adaptive !== null &&
      RETURN_TO_ORIGINAL &&
      active.qualityChoice === "auto" &&
      active.originalUsable &&
      this.estimator.kbps !== null &&
      originalFits(this.estimator.kbps, active.originalKbps)
    ) {
      await this.replaceStream(active, null, positionSeconds);
      return this.publishIfActive(active);
    }
    if (this.conversion !== null) {
      active.replacingSource = true;
      this.unload();
      const generation = ++this.generation;
      try {
        await this.load(generation, active.session, positionSeconds);
      } catch (cause) {
        if (generation === this.generation) active.replacingSource = false;
        if (generation === this.generation || this.active !== active) throw cause;
      }
      if (this.active !== active) throw inactive();
      if (generation !== this.generation) return this.snapshot(active);
      active.replacingSource = false;
      if (!active.desiredPaused) await this.play(active);
    } else this.element.currentTime = positionSeconds;
    return this.publishIfActive(active);
  }

  buffer(sessionId: string): PlayerBuffer {
    const active = this.requireActive(sessionId);
    const { element } = this;
    const aheadSeconds = this.bufferedAhead();
    return {
      aheadSeconds,
      // A seek also makes the element wait; that is not running out.
      // Nor can fetching replenish a file whose entire remainder is already buffered.
      starved:
        active.buffering &&
        !element.paused &&
        !element.seeking &&
        aheadSeconds !== Number.POSITIVE_INFINITY,
      // A paused browser fetches only as much as it sees fit, and reports what it holds by its
      // own estimate, so it may come to rest short of any amount that is waited for.
      settled:
        !element.seeking &&
        element.readyState >= HAVE_FUTURE_DATA &&
        element.networkState === NETWORK_IDLE,
    };
  }

  private bufferedAhead(): number {
    const { element } = this;
    if (element.seeking) return 0;
    const position = element.currentTime;
    const end = Number.isFinite(element.duration) ? element.duration : Number.POSITIVE_INFINITY;
    // Nothing is left to fetch at the end, where the element reports no data to play on with.
    if (element.ended || position >= end - END_TOLERANCE_SECONDS) return Number.POSITIVE_INFINITY;
    if (element.readyState < HAVE_CURRENT_DATA) return 0;
    for (let index = 0; index < element.buffered.length; index += 1) {
      const rangeEnd = element.buffered.end(index);
      if (element.buffered.start(index) > position || rangeEnd <= position) continue;
      // WebKit can retain HAVE_CURRENT_DATA after a completed seek into a fully downloaded
      // file. Waiting for another fetch then deadlocks a paused watch group; it has all the
      // media it needs. Incomplete ranges still require playable future data.
      if (rangeEnd >= end - END_TOLERANCE_SECONDS) return Number.POSITIVE_INFINITY;
      return element.readyState >= HAVE_FUTURE_DATA ? rangeEnd - position : 0;
    }
    return 0;
  }

  async speed(sessionId: string, speed: number): Promise<void> {
    this.requireActive(sessionId);
    if (!Number.isFinite(speed) || speed < 0.9 || speed > 1.1)
      throw new Error("Invalid playback speed");
    this.element.playbackRate = speed;
  }

  async volume(sessionId: string, volume: number, muted: boolean): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const bounded = Math.max(0, Math.min(100, Math.round(volume)));
    this.element.volume = bounded / 100;
    this.element.muted = muted;
    const settings = { volume: bounded, muted };
    // Read again rather than kept: another tab may have remembered a title since.
    this.volumeMemory?.write(
      rememberTitleVolume(
        this.volumeMemory.read() ?? settings,
        active.session.titleId ?? null,
        settings,
      ),
    );
    return this.publish(active);
  }

  async selectAudioStream(sessionId: string, streamId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    await active.selection?.select("audio", streamId);
    return this.publishIfActive(active);
  }

  async resetTrack(sessionId: string, kind: TrackKind): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    await active.selection?.reset(kind);
    return this.publishIfActive(active);
  }

  async retryTrackMemory(sessionId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    await active.selection?.retry();
    return this.publishIfActive(active);
  }

  async dismissTrackMemoryError(sessionId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    await active.selection?.dismissError();
    return this.publishIfActive(active);
  }

  private async applyAudio(active: ActiveSession, streamId: string | null): Promise<void> {
    if (this.adaptive !== null) {
      const audioIndex = active.streams.findIndex((stream) => stream.id === streamId);
      if (audioIndex < 0) throw new Error("Audio stream is unavailable");
      active.selectedAudioStreamId = streamId;
      this.adaptiveAudioIndex = audioIndex;
      await this.replaceStream(
        active,
        this.adaptive.loadingRendition,
        this.snapshot(active).positionSeconds,
      );
      return;
    }
    if (this.conversion !== null) {
      const audioIndex = active.streams.findIndex((stream) => stream.id === streamId);
      if (audioIndex < 0) throw new Error("Audio stream is unavailable");
      const position = this.snapshot(active).positionSeconds;
      this.conversion = {
        ...this.conversion,
        audioIndex,
        audio: this.conversion.format === "webm" ? "opus" : "aac",
      };
      await this.seek(active.session.sessionId, position);
      active.selectedAudioStreamId = streamId;
      return;
    }
    const tracks = this.element.audioTracks;
    const index = active.streams.findIndex((stream) => stream.id === streamId);
    if (tracks === undefined || index < 0 || tracks.length !== active.streams.length)
      throw new Error("Audio stream is unavailable");
    const stream = active.streams[index];
    const probe = audioCodecProbe(
      stream?.codec ?? null,
      active.session.media?.mimeType ?? "audio/mp4",
    );
    if (probe !== null && this.element.canPlayType(probe) === "") {
      this.conversion = {
        ...fallbackTranscodingPlan(active.session, (mime) => this.element.canPlayType(mime)),
        audioIndex: index,
      };
      return this.applyAudio(active, streamId);
    }
    for (let track = 0; track < tracks.length; track += 1) {
      const entry = tracks[track];
      if (entry !== undefined) entry.enabled = track === index;
    }
    if (tracks[index]?.enabled !== true)
      throw new Error("This browser could not switch audio tracks");
    active.selectedAudioStreamId = streamId;
  }

  /** "auto", "original", or a rendition id. */
  async selectQuality(sessionId: string, choice: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const rendition = active.renditions.find((candidate) => candidate.id === choice) ?? null;
    if (choice !== "auto" && choice !== "original" && rendition === null)
      throw new Error("Quality is unavailable");
    active.qualityChoice = choice;
    active.originalReturn.reset();
    const position = this.snapshot(active).positionSeconds;
    if (choice === "original" && this.adaptive !== null)
      await this.replaceStream(active, null, position);
    else if (rendition !== null && this.adaptive === null)
      await this.replaceStream(active, rendition, position);
    else this.adaptive?.choose(choice);
    return this.publishIfActive(active);
  }

  /**
   * Starts playback the browser held back until the viewer interacted. Call it from the click
   * itself: the browser only honours `play()` while it is handling a gesture.
   */
  async allowPlayback(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    active.awaitingInteraction = false;
    // Only a request made during the click is honoured, so one the browser already holds is no
    // reason not to ask.
    active.heldPlay = null;
    await this.play(active);
    if (this.active === active) this.publish(active);
  }

  sample(sessionId: string): WatchPlaybackSample {
    const active = this.requireActive(sessionId);
    const state = this.snapshot(active);
    return {
      ...state,
      sampledAtMs: performance.now(),
      speed: this.element.playbackRate,
      advancing:
        !state.paused &&
        !this.element.ended &&
        !this.element.seeking &&
        !active.buffering &&
        !active.suspended &&
        !active.awaitingInteraction &&
        (this.element.readyState >= HAVE_FUTURE_DATA ||
          this.bufferedAhead() === Number.POSITIVE_INFINITY),
    };
  }

  recordSynchronization(fields: Parameters<PlaybackDiagnostics["record"]>[1]): void {
    this.diagnostics.record("watch_synchronization", fields);
  }

  getState(): PlayerState | null {
    return this.active === null ? null : this.snapshot(this.active);
  }

  /** The state of a session that is still the one playing. */
  info(sessionId: string): PlaybackInfo {
    const active = this.requireActive(sessionId);
    const { element } = this;
    const quality = element.getVideoPlaybackQuality?.();
    return describePlayback(active.session, this.api.serverOrigin, active.selectedAudioStreamId, {
      player: "HTML video player",
      playerSize: measuredSize(element.clientWidth, element.clientHeight),
      videoSize: measuredSize(element.videoWidth, element.videoHeight),
      droppedFrames: quality?.droppedVideoFrames ?? null,
      corruptedFrames: quality?.corruptedVideoFrames ?? null,
    });
  }

  getActiveState(sessionId: string): PlayerState {
    return this.snapshot(this.requireActive(sessionId));
  }

  async stop(): Promise<void> {
    this.generation += 1;
    rememberThroughput(this.api.serverOrigin, this.estimator.kbps);
    await this.stopActive();
  }

  /**
   * The page is going away. Timers will not run again, so save where the viewer is and end the
   * session with requests the browser may finish after the page is gone. Nothing here can be
   * relied on to arrive: a session that is never closed expires on the server.
   */
  leave(): void {
    const active = this.active;
    if (active === null || active.suspended) return;
    active.suspendedPositionSeconds = this.snapshot(active).positionSeconds;
    active.suspended = true;
    active.playingBeforeSuspend = !active.desiredPaused;
    this.element.pause();
    this.leaving = true;
    const state = this.snapshot(active);
    this.unload();
    void active.reporter
      .saveProgress(state)
      .then(() => active.reporter.end())
      .finally(() => {
        this.leaving = false;
      });
  }

  /**
   * The page was hidden. It may be discarded without another chance to run, so save the position
   * now with a request that can outlive the page.
   */
  checkpoint(): void {
    const active = this.active;
    if (active === null || active.suspended) return;
    this.leaving = true;
    void active.reporter.saveProgress(this.snapshot(active)).finally(() => {
      this.leaving = false;
    });
  }

  /**
   * The page came back from being hidden, suspended or offline. Timers were not running, so the
   * server may have expired the session and its media grant. Ask before resuming, and reopen the
   * session at the same position if it is gone.
   */
  async reconcile(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    if (!active.suspended) {
      try {
        await this.api.heartbeat(active.session.sessionId, this.snapshot(active));
        return;
      } catch (cause) {
        // Unreachable server: keep what is buffered and wait for the next chance to ask.
        if (!(cause instanceof ServerHttpError) || cause.status === 401 || cause.status >= 500)
          return;
      }
    }
    if (this.active === active) await this.reopen(active);
  }

  private async open(
    generation: number,
    itemId: string,
    startAtSeconds: number,
    paused: boolean,
    previousChoice?: string,
  ): Promise<void> {
    const session = await this.api.startPlayback(itemId);
    const reporter = new PlaybackSessionReporter(this.sessionApi(), session.sessionId, () => {
      // A failed report is retried by the next one; it must not interrupt playback.
    });
    if (generation !== this.generation) {
      await reporter.end();
      throw cancelled();
    }
    const plan = transcodingPlan(
      session,
      (mime) => this.element.canPlayType(mime),
      this.element.audioTracks !== undefined,
    );
    const renditions =
      this.api.supportsAdaptive === true &&
      adaptivePlaybackSupported() &&
      this.element.canPlayType('video/mp4; codecs="avc1.4d4028"') !== "" &&
      typeof HTMLMediaElement !== "undefined" &&
      this.element instanceof HTMLMediaElement &&
      session.media?.video != null
        ? adaptiveRenditionsFor(session.media.video.size?.height ?? null)
        : [];
    this.adaptiveAudioIndex = selectedAudio(session).index;
    this.openingChoice = previousChoice ?? "auto";
    const quality: {
      renditions: ReadonlyArray<AdaptiveRendition>;
      choice: string;
      originalKbps: number | null;
      originalUsable: boolean;
    } = {
      renditions,
      choice: previousChoice ?? "auto",
      originalKbps: originalKbps(session.media?.sizeBytes, session.durationSeconds),
      originalUsable: !this.forceConversion && (plan === null || plan.video === "copy"),
    };
    try {
      this.conversion = this.forceConversion
        ? fallbackTranscodingPlan(session, (mime) => this.element.canPlayType(mime))
        : plan;
      this.nextAdaptive = this.startingQuality(quality);
      this.applyRememberedVolume(session);
      try {
        await this.loadAt(generation, session, startAtSeconds).catch(async (cause: unknown) => {
          // Conversion can be off on a server that offers it; the original still plays.
          if (
            generation !== this.generation ||
            this.nextAdaptive === null ||
            !quality.originalUsable
          )
            throw cause;
          quality.renditions = [];
          this.nextAdaptive = null;
          this.unload();
          await this.loadAt(generation, session, startAtSeconds);
        });
      } catch (cause) {
        if (
          generation !== this.generation ||
          this.nextAdaptive !== null ||
          (this.conversion !== null &&
            this.conversion.video !== "copy" &&
            this.conversion.audio !== "copy") ||
          !(cause instanceof PlaybackUnsupportedError)
        )
          throw cause;
        this.forceConversion = true;
        quality.originalUsable = false;
        this.conversion = fallbackTranscodingPlan(session, (mime) =>
          this.element.canPlayType(mime),
        );
        this.nextAdaptive = renditions.length === 0 ? null : this.startingQuality(quality);
        this.unload();
        await this.loadAt(generation, session, startAtSeconds);
      }
    } catch (cause) {
      // Only the latest start owns the element. A replaced one must leave its successor's
      // source alone and just close the session it opened.
      if (generation === this.generation) this.unload();
      await reporter.end();
      throw cause;
    }
    const audioStreams = session.streams
      .filter((stream) => stream.kind === "audio")
      .sort((a, b) => a.ordinal - b.ordinal);
    // Offer audio tracks only when the browser exposes exactly the tracks the server lists.
    const switchable =
      audioStreams.length > 0 &&
      (this.conversion !== null ||
        this.adaptive !== null ||
        this.element.audioTracks?.length === audioStreams.length);
    const active: ActiveSession = {
      session,
      reporter,
      streams: switchable ? audioStreams : [],
      detach: () => undefined,
      selectedAudioStreamId: null,
      selection: null,
      trackMemoryError: null,
      trackPreferences: session.trackMemory?.preferences ?? DEFAULT_TRACK_PREFERENCES,
      buffering: false,
      awaitingInteraction: false,
      heldPlay: null,
      suspended: false,
      playingBeforeSuspend: false,
      suspendedPositionSeconds: null,
      desiredPaused: paused,
      replacingSource: false,
      renditions: quality.renditions,
      qualityChoice: quality.choice,
      originalKbps: quality.originalKbps,
      originalUsable: quality.originalUsable,
      originalReturn: new OriginalReturn(),
      lastBufferSample: null,
      starvedSinceMs: null,
    };
    this.active = active;
    try {
      const selected = resolveTrackSelection(
        audioStreams,
        session.sourceId,
        session.trackMemory,
      ).audio;
      if (switchable && selected !== null) {
        if (this.conversion !== null || this.adaptive !== null)
          active.selectedAudioStreamId = selected.id;
        else await this.applyAudio(active, selected.id);
      }

      active.selection = new TrackSelectionController({
        sourceId: session.sourceId,
        ...(session.trackMemory === undefined ? {} : { memory: session.trackMemory }),
        streams: active.streams,
        assertActive: () => {
          if (this.active !== active) throw inactive();
        },
        apply: async (kind, streamId) => {
          // Resetting an unsupported kind still clears its server override for other devices.
          if (kind === "audio" && switchable) await this.applyAudio(active, streamId);
        },
        save: (choice) => this.api.saveTrackChoice(session.sessionId, choice),
        onError: (message) => {
          active.trackMemoryError = message;
          this.publishIfActive(active);
        },
        onPreferences: (preferences) => {
          active.trackPreferences = preferences;
          this.publishIfActive(active);
        },
      });
    } catch (cause) {
      await this.stopActive({ saveProgress: false });
      throw cause;
    }
    active.detach = this.attach(active);
    try {
      if (!paused) await this.play(active);
    } catch (cause) {
      if (this.active === active) await this.stopActive({ saveProgress: false });
      throw cause;
    }
    if (this.active === active) this.publish(active);
  }

  /** Without anything remembered, the volume the element already has stands. */
  private applyRememberedVolume(session: PlayerSession): void {
    const memory = this.volumeMemory?.read() ?? null;
    if (memory === null) return;
    const { volume, muted } = volumeForTitle(memory, session.titleId ?? null);
    this.element.volume = volume / 100;
    this.element.muted = muted;
  }

  /** Where Auto starts, or the viewer's own choice: null plays the original. */
  private startingQuality(quality: {
    readonly renditions: ReadonlyArray<AdaptiveRendition>;
    readonly choice: string;
    readonly originalKbps: number | null;
    readonly originalUsable: boolean;
  }): AdaptiveRendition | null {
    const { renditions, choice } = quality;
    if (renditions.length === 0 || choice === "original") return null;
    const chosen = renditions.find((rendition) => rendition.id === choice);
    if (chosen !== undefined) return chosen;
    if (quality.originalUsable && originalFits(this.estimator.kbps, quality.originalKbps))
      return null;
    return startingRendition(renditions, this.estimator.kbps) ?? null;
  }

  /** Loads what `nextAdaptive` names and brings it to `start`. */
  private async loadAt(generation: number, session: PlayerSession, start: number): Promise<void> {
    const rendition = this.nextAdaptive;
    if (rendition !== null) {
      await this.loadAdaptive(generation, session, rendition, start);
      return;
    }
    await this.load(generation, session, this.conversion === null ? 0 : start);
    // The element is shared: metadata may have arrived for a newer start's source.
    if (generation !== this.generation) throw cancelled();
    if (this.conversion === null && Number.isFinite(start) && start > 0) {
      this.element.currentTime = start;
      // Starting while the initial seek is pending can leave WebKit waiting indefinitely.
      if (this.element.seeking) await this.waitForMediaEvent(generation, "seeked");
      if (generation !== this.generation) throw cancelled();
    }
  }

  private async loadAdaptive(
    generation: number,
    session: PlayerSession,
    rendition: AdaptiveRendition,
    start: number,
  ): Promise<void> {
    const Hls = await AdaptiveSource.load();
    if (generation !== this.generation) throw cancelled();
    const element = this.element as HTMLMediaElement;
    const url = new URL(
      `${session.streamUrl}/adaptive/${this.adaptiveAudioIndex}/master.m3u8`,
      this.api.serverOrigin,
    );
    url.searchParams.set("grant", session.grantToken);
    const renditions = adaptiveRenditionsFor(session.media?.video?.size?.height ?? null);
    let failLoad: (cause: Error) => void = () => {};
    const source = new AdaptiveSource(element, {
      url: url.toString(),
      startSeconds: start,
      renditions,
      start: rendition,
      choice: this.active?.qualityChoice ?? this.openingChoice,
      estimator: this.estimator,
      onChange: () => {
        if (this.active !== null && this.adaptive === source) this.publish(this.active);
      },
      onFatal: (cause) => {
        if (this.adaptive !== source) return;
        const active = this.active;
        // While a session is still opening, nothing plays yet: the load it waits on fails instead.
        if (active === null) failLoad(cause);
        else void this.withoutConversion(active, this.snapshot(active).positionSeconds, cause);
      },
    });
    this.adaptive = source;
    this.timeOffset = 0;
    await this.waitForMediaEvent(generation, "loadedmetadata", (fail) => {
      failLoad = fail;
      source.attach(Hls);
    });
  }

  /**
   * Swaps the original for converted pieces or back, at a position: the one move between them
   * that cannot be seamless, since the two are different streams.
   */
  private async replaceStream(
    active: ActiveSession,
    rendition: AdaptiveRendition | null,
    positionSeconds: number,
  ): Promise<void> {
    active.replacingSource = true;
    active.lastBufferSample = null;
    this.unload();
    this.nextAdaptive = rendition;
    if (rendition === null && this.conversion !== null && !active.originalUsable)
      this.conversion = fallbackTranscodingPlan(active.session, (mime) =>
        this.element.canPlayType(mime),
      );
    const generation = ++this.generation;
    try {
      await this.loadAt(generation, active.session, positionSeconds);
    } catch (cause) {
      if (generation === this.generation) active.replacingSource = false;
      if (generation === this.generation || this.active !== active) throw cause;
    }
    if (this.active !== active) throw inactive();
    if (generation !== this.generation) return;
    active.replacingSource = false;
    if (!active.desiredPaused) await this.play(active);
  }

  /**
   * Auto's moves between the original and converted pieces, checked as playback goes on: away
   * from the original when the connection cannot keep it fed, back once it has proven it can.
   */
  private watchQuality(active: ActiveSession): void {
    if (active.replacingSource || active.qualityChoice !== "auto" || active.renditions.length === 0)
      return;
    const nowMs = performance.now();
    const adaptive = this.adaptive;
    if (adaptive !== null) {
      adaptive.decide();
      if (
        active.originalUsable &&
        active.originalReturn.observe(nowMs, this.estimator.kbps, active.originalKbps)
      )
        this.switchInBackground(active, null);
      return;
    }
    if (!active.originalUsable) return;
    // The original's connection is measured by how fast the buffer grows while the browser
    // fetches: seconds of file gained, at the file's average bitrate.
    const ahead = this.bufferedAhead();
    const end = this.element.currentTime + (Number.isFinite(ahead) ? ahead : 0);
    const last = active.lastBufferSample;
    if (
      last !== null &&
      active.originalKbps !== null &&
      this.element.networkState === 2 &&
      Number.isFinite(ahead) &&
      end > last.endSeconds
    )
      this.estimator.sample(
        ((end - last.endSeconds) * active.originalKbps * 1000) / 8,
        nowMs - last.atMs,
        end - last.endSeconds,
      );
    active.lastBufferSample = { atMs: nowMs, endSeconds: end };
    if (
      Number.isFinite(ahead) &&
      shouldLeaveOriginal({
        stalledSeconds:
          active.starvedSinceMs === null || this.element.paused
            ? 0
            : (nowMs - active.starvedSinceMs) / 1000,
        bufferAheadSeconds: ahead,
        estimateKbps: this.estimator.kbps,
        originalKbps: active.originalKbps,
      })
    ) {
      if (
        active.starvedSinceMs !== null &&
        originalStalled((nowMs - active.starvedSinceMs) / 1000) &&
        active.originalKbps !== null
      )
        this.estimator.capAt(active.originalKbps * 0.9);
      const rendition = startingRendition(active.renditions, this.estimator.kbps);
      if (rendition !== undefined) this.switchInBackground(active, rendition);
    }
  }

  /** A switch Auto makes on its own; failing it ends playback as any other loss of media would. */
  private switchInBackground(active: ActiveSession, rendition: AdaptiveRendition | null): void {
    const position = this.snapshot(active).positionSeconds;
    void this.replaceStream(active, rendition, position).catch((cause: unknown) =>
      this.withoutConversion(active, position, cause),
    );
  }

  /**
   * Converted pieces failed, as when an administrator turns conversion off: the original plays
   * on and the qualities are no longer offered. Without a playable original, playback ends.
   */
  private async withoutConversion(
    active: ActiveSession,
    positionSeconds: number,
    cause: unknown,
  ): Promise<void> {
    if (this.active !== active) return;
    const failure = cause instanceof Error ? cause : new Error("Playback could not continue.");
    if (!active.originalUsable || active.renditions.length === 0) {
      await this.fail(failure);
      return;
    }
    active.renditions = [];
    active.qualityChoice = "auto";
    try {
      await this.replaceStream(active, null, positionSeconds);
      this.publishIfActive(active);
    } catch {
      if (this.active === active) await this.fail(failure);
    }
  }

  /** Points the element at the media and waits until the browser can tell whether it will play. */
  private load(generation: number, session: PlayerSession, start = 0): Promise<void> {
    // The grant authorises this one file for this one session. It appears only in the element's
    // source: never in state handed to the application, and never in anything that is stored.
    const url = new URL(session.streamUrl, this.api.serverOrigin);
    url.searchParams.set("grant", session.grantToken);
    this.timeOffset = this.conversion === null ? 0 : start;
    if (this.conversion !== null) setTranscodingParameters(url, this.conversion, start);
    return this.waitForMediaEvent(generation, "loadedmetadata", () => {
      this.element.src = url.toString();
      this.element.load();
    });
  }

  private waitForMediaEvent(
    generation: number,
    event: "loadedmetadata" | "seeked",
    start: (fail: (cause: Error) => void) => void = () => {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        clearInterval(watchdog);
        this.element.removeEventListener(event, onReady);
        this.element.removeEventListener("error", onError);
        outcome();
      };
      const onReady = (): void => settle(resolve);
      const onError = (): void =>
        settle(() => reject(describeMediaError(this.element.error?.code)));
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new Error(
                `Timed out waiting for media to ${event === "loadedmetadata" ? "load" : "seek"}`,
              ),
            ),
          ),
        this.loadTimeoutMs,
      );
      // A newer start or stop abandons this load without waiting for the browser to give up.
      const watchdog = setInterval(() => {
        if (generation !== this.generation) settle(() => reject(cancelled()));
      }, 50);
      this.element.addEventListener(event, onReady);
      this.element.addEventListener("error", onError);
      try {
        start((cause) => settle(() => reject(cause)));
      } catch (cause) {
        settle(() => reject(cause));
      }
    });
  }

  /**
   * Asks the browser to play and waits a moment for its answer. A browser may hold the request
   * instead of answering it, for as long as it likes, so the wait is bounded: commands carry on
   * with the element as it stands, and whatever the browser decides later is recorded then.
   */
  private async play(active: ActiveSession): Promise<void> {
    if (active.heldPlay !== null) return;
    const answer = this.requestPlay(active);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = await Promise.race([
      answer.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.playAnswerTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!held) return;
    const heldPlay = answer
      .then(
        () => {
          if (this.active === active) this.publish(active);
        },
        (cause: unknown) => {
          if (this.active !== active) return;
          return this.fail(cause instanceof Error ? cause : new Error("Playback could not start."));
        },
      )
      .finally(() => {
        if (active.heldPlay === heldPlay) active.heldPlay = null;
      });
    active.heldPlay = heldPlay;
  }

  /** Settles once the browser has started playback or declined to; rejects if it cannot play. */
  private async requestPlay(active: ActiveSession): Promise<void> {
    try {
      await this.element.play();
      active.awaitingInteraction = false;
    } catch (cause) {
      // A pause or a new source interrupted the request; whatever did that owns the outcome.
      if (isAbort(cause) || this.active !== active) return;
      if (cause instanceof Error && cause.name === "NotAllowedError") {
        // The browser will not start playback on its own. Stay paused and ask for a click.
        active.awaitingInteraction = true;
        return;
      }
      throw cause instanceof Error && cause.name === "NotSupportedError"
        ? new PlaybackUnsupportedError(UNSUPPORTED_FORMAT)
        : cause;
    }
  }

  private attach(active: ActiveSession): () => void {
    const update = (): void => {
      if (this.active === active) this.publish(active);
    };
    const buffering = (waiting: boolean) => (): void => {
      active.buffering = waiting;
      if (!waiting) active.starvedSinceMs = null;
      else if (!this.element.seeking) active.starvedSinceMs ??= performance.now();
      update();
    };
    const record = (kind: string): void => {
      if (this.active !== active) return;
      const state = this.snapshot(active);
      const range = state.bufferedRanges.find(
        (range) =>
          range.startSeconds <= state.positionSeconds && range.endSeconds >= state.positionSeconds,
      );
      this.diagnostics.record(kind, {
        sessionId: active.session.sessionId,
        positionSeconds: state.positionSeconds,
        aheadSeconds: range === undefined ? 0 : range.endSeconds - state.positionSeconds,
        intentionalPause: this.element.paused,
        seeking: this.element.seeking,
        eof: this.element.ended,
        readyState: this.element.readyState,
        mediaErrorCode: this.element.error?.code ?? null,
      });
    };
    // Where playback last waited or was sought to; moving past it means playback goes on.
    let resumesPastSeconds = 0;
    const onWaiting = (): void => {
      record("browser_waiting");
      const loading = this.adaptive?.loadingRendition;
      if (loading !== undefined && !this.element.seeking)
        this.estimator.capAt(loading.maxKbps * 0.9);
      resumesPastSeconds = this.element.currentTime;
      buffering(true)();
    };
    const onSeeking = (): void => {
      resumesPastSeconds = this.element.currentTime;
      active.starvedSinceMs = null;
      update();
    };
    const onPlaying = (): void => {
      if (active.buffering) record("browser_recovery");
      buffering(false)();
    };
    const onTimeUpdate = (): void => {
      // WebKit may follow a wait with neither playing nor canplay. A clock that moves on is playing.
      if (
        active.buffering &&
        !this.element.seeking &&
        this.element.currentTime > resumesPastSeconds
      )
        onPlaying();
      else update();
    };
    const onSeeked = (): void => {
      // WebKit can keep HAVE_CURRENT_DATA after seeking in a fully downloaded file,
      // even while its clock advances. No further canplay/playing event is guaranteed.
      if (this.bufferedAhead() > 0) {
        active.buffering = false;
        active.starvedSinceMs = null;
      }
      update();
    };
    const onError = (): void => {
      record("browser_error");
      if (this.active === active) void this.recover(active, this.element.error?.code);
    };
    const onEnded = (): void => {
      update();
      void active.reporter.saveProgress(this.snapshot(active));
    };
    const listeners: ReadonlyArray<readonly [string, () => void]> = [
      ["timeupdate", onTimeUpdate],
      ["durationchange", update],
      ["progress", update],
      ["play", update],
      ["pause", update],
      ["seeking", onSeeking],
      ["seeked", onSeeked],
      ["volumechange", update],
      ["waiting", onWaiting],
      ["stalled", () => record("browser_stalled")],
      ["playing", onPlaying],
      ["canplay", onPlaying],
      ["ended", onEnded],
      ["error", onError],
    ];
    for (const [type, listener] of listeners) this.element.addEventListener(type, listener);
    const timer = setInterval(() => {
      if (this.active === active && !active.suspended)
        void active.reporter.tick(this.snapshot(active));
    }, PLAYBACK_REPORT_INTERVAL_MS);
    const qualityTimer = setInterval(() => {
      if (this.active === active && !active.suspended) this.watchQuality(active);
    }, 1000);
    return () => {
      clearInterval(qualityTimer);
      clearInterval(timer);
      for (const [type, listener] of listeners) this.element.removeEventListener(type, listener);
    };
  }

  /** Playback broke after it had started. A lost connection is worth reopening; a bad file is not. */
  private async recover(active: ActiveSession, code: number | undefined): Promise<void> {
    const nowMs = Date.now();
    this.recoveries = this.recoveries.filter((at) => nowMs - at < RECOVERY_WINDOW_MS);
    const incompatible =
      (this.conversion === null ||
        this.conversion.video === "copy" ||
        this.conversion.audio === "copy") &&
      (code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED);
    if (incompatible) this.forceConversion = true;
    if ((!incompatible && code !== MEDIA_ERR_NETWORK) || this.recoveries.length >= MAX_RECOVERIES) {
      await this.fail(describeMediaError(code));
      return;
    }
    this.recoveries.push(nowMs);
    await this.reopen(active);
  }

  /** Replaces a session the server no longer honours with a new one at the same position. */
  private async reopen(active: ActiveSession): Promise<void> {
    const { positionSeconds } = this.snapshot(active);
    const wasPaused = active.suspended
      ? !active.playingBeforeSuspend
      : active.desiredPaused && !active.awaitingInteraction;
    const generation = ++this.generation;
    // The application keeps showing this playback while its session is replaced.
    await this.stopActive({ saveProgress: false, announce: false });
    if (generation !== this.generation) return;
    try {
      await this.open(
        generation,
        active.session.itemId,
        positionSeconds,
        wasPaused,
        active.qualityChoice,
      );
    } catch (cause) {
      if (generation !== this.generation) return;
      // The old session was retired quietly; now that nothing replaces it, say that it is gone.
      this.onState(null);
      await this.fail(cause instanceof Error ? cause : new Error("Playback could not resume."));
    }
  }

  private async fail(cause: Error): Promise<void> {
    this.generation += 1;
    await this.stopActive();
    this.onFailure(cause);
  }

  private stopActive({
    saveProgress = true,
    announce = true,
  }: {
    readonly saveProgress?: boolean;
    readonly announce?: boolean;
  } = {}): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const active = this.active;
    if (active === null) return Promise.resolve();
    const state = this.snapshot(active);
    this.active = null;
    active.detach();
    active.reporter.retire();
    this.unload();
    if (announce) this.onState(null);
    const stopping = (async () => {
      // A suspended session has already saved its position and ended.
      if (saveProgress && !active.suspended) await active.reporter.saveProgress(state);
      if (!active.suspended) await active.reporter.end();
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  private unload(): void {
    this.adaptive?.destroy();
    this.adaptive = null;
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.element.playbackRate = 1;
  }

  private sessionApi(): PlaybackSessionApi {
    return {
      heartbeat: (sessionId, state) => this.api.heartbeat(sessionId, state),
      progress: (sessionId, state, sequence, init) =>
        this.api.progress(sessionId, state, sequence, { ...init, keepalive: this.leaving }),
      stopPlayback: (sessionId) => this.api.stopPlayback(sessionId, { keepalive: this.leaving }),
    };
  }

  private snapshot(active: ActiveSession): PlayerState {
    const { element } = this;
    const bufferedRanges = [];
    for (let index = 0; index < element.buffered.length; index += 1) {
      const startSeconds = element.buffered.start(index) + this.timeOffset;
      const endSeconds = element.buffered.end(index) + this.timeOffset;
      if (endSeconds > startSeconds) bufferedRanges.push({ startSeconds, endSeconds });
    }
    return {
      sessionId: active.session.sessionId,
      itemId: active.session.itemId,
      paused: active.replacingSource ? active.desiredPaused : element.paused,
      positionSeconds:
        active.suspendedPositionSeconds ??
        (Number.isFinite(element.currentTime)
          ? element.currentTime + this.timeOffset
          : this.timeOffset),
      durationSeconds:
        this.conversion === null && Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : active.session.durationSeconds,
      bufferedRanges,
      volume: Math.round(element.volume * 100),
      muted: element.muted,
      ended: element.ended,
      streams: active.streams,
      selectedAudioStreamId: active.selectedAudioStreamId,
      selectedSubtitleStreamId: null,
      trackMemoryError: active.trackMemoryError,
      trackPreferences: active.trackPreferences,
      // The browser decides the channel layout; this is the closest of the two descriptions.
      audioOutput: "auto-safe",
      buffering: active.buffering && !element.paused,
      awaitingInteraction: active.awaitingInteraction,
      ...(active.renditions.length === 0
        ? {}
        : {
            quality: qualityState({
              choice: active.qualityChoice,
              playing:
                this.adaptive === null
                  ? "original"
                  : (this.adaptive.playingRendition ?? this.adaptive.loadingRendition).id,
              original: {
                height: active.session.media?.video?.size?.height ?? null,
                kbps: active.originalKbps,
              },
              renditions: active.renditions,
              measuredKbps: this.estimator.kbps,
            }),
          }),
    };
  }

  private publish(active: ActiveSession): PlayerState {
    const state = this.snapshot(active);
    this.onState(state);
    return state;
  }

  /**
   * Publishes after a command that had to wait. The element is shared, so if the session was
   * replaced meanwhile its state would be the replacement's media under the old session's name.
   */
  private publishIfActive(active: ActiveSession): PlayerState {
    if (this.active !== active) throw inactive();
    return this.publish(active);
  }

  private requireActive(sessionId: string): ActiveSession {
    if (this.active === null || this.active.session.sessionId !== sessionId) throw inactive();
    return this.active;
  }
}
