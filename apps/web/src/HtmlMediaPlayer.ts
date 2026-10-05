import {
  PLAYBACK_REPORT_INTERVAL_MS,
  type PlaybackSessionApi,
  type PlayerBuffer,
  PlaybackSessionReporter,
  PlaybackUnsupportedError,
  ServerHttpError,
} from "@lumen/client";
import type { PlayableStream, PlayerSession, PlayerState } from "@lumen/contracts";

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
  readonly error: { readonly code: number } | null;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
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
  readonly startPlayback: (itemId: string) => Promise<PlayerSession>;
  readonly heartbeat: (sessionId: string, state: PlayerState) => Promise<void>;
  readonly progress: (
    sessionId: string,
    state: PlayerState,
    sequence: number,
    init?: { readonly keepalive?: boolean },
  ) => Promise<void>;
  readonly stopPlayback: (
    sessionId: string,
    init?: { readonly keepalive?: boolean },
  ) => Promise<void>;
}

export interface HtmlMediaPlayerOptions {
  readonly element: MediaElementLike;
  readonly api: BrowserPlaybackApi;
  readonly onState: (state: PlayerState | null) => void;
  /** Playback that had started can no longer continue. */
  readonly onFailure: (cause: Error) => void;
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
  buffering: boolean;
  awaitingInteraction: boolean;
  /** A request to play that the browser is holding, having neither started nor refused it. */
  heldPlay: Promise<void> | null;
  /** The page was hidden and the server session ended; it must be reopened before resuming. */
  suspended: boolean;
  /** Whether playback was running when the page was hidden. */
  playingBeforeSuspend: boolean;
}

const LOAD_TIMEOUT_MS = 20_000;
// A browser that will start or refuse playback says so at once. One that takes longer is holding
// the request: until it has media to play, or until a page opened in the background is first shown.
const PLAY_ANSWER_TIMEOUT_MS = 1000;
const MAX_RECOVERIES = 2;
const RECOVERY_WINDOW_MS = 60_000;

// HTMLMediaElement.readyState: there is enough data past the current position for playback to
// advance. One state lower, only the current frame is there and playing would stall at once.
const HAVE_FUTURE_DATA = 3;
// What a browser has buffered can stop a little short of the duration it reports.
const END_TOLERANCE_SECONDS = 0.5;

// MediaError.code
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const UNSUPPORTED_FORMAT =
  "This browser can’t play this file’s format. Try another browser or the Lumen desktop app.";

// What to ask the browser about an audio codec. Codecs it plays everywhere are not listed.
const audioCodecProbes: Readonly<Record<string, string>> = {
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  dts: 'audio/mp4; codecs="dtsc"',
  truehd: 'audio/mp4; codecs="mlpa"',
};

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
  private readonly loadTimeoutMs: number;
  private readonly playAnswerTimeoutMs: number;
  private active: ActiveSession | null = null;
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private recoveries: number[] = [];
  private leaving = false;

  constructor(options: HtmlMediaPlayerOptions) {
    this.element = options.element;
    this.api = options.api;
    this.onState = options.onState;
    this.onFailure = options.onFailure;
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
    await this.open(generation, input.itemId, input.startAtSeconds ?? 0, input.paused === true);
  }

  async pause(sessionId: string, paused: boolean): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (paused) {
      this.element.pause();
      await active.reporter.saveProgress(this.snapshot(active));
    } else await this.play(active);
    return this.publishIfActive(active);
  }

  async seek(sessionId: string, positionSeconds: number): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
      throw new Error("Invalid position");
    this.element.currentTime = positionSeconds;
    return this.publish(active);
  }

  buffer(sessionId: string): PlayerBuffer {
    const active = this.requireActive(sessionId);
    const { element } = this;
    return {
      aheadSeconds: this.bufferedAhead(),
      // A seek also makes the element wait; that is not running out.
      starved: active.buffering && !element.paused && !element.seeking,
    };
  }

  private bufferedAhead(): number {
    const { element } = this;
    if (element.seeking) return 0;
    const position = element.currentTime;
    const end = Number.isFinite(element.duration) ? element.duration : Number.POSITIVE_INFINITY;
    // Nothing is left to fetch at the end, where the element reports no data to play on with.
    if (element.ended || position >= end - END_TOLERANCE_SECONDS) return Number.POSITIVE_INFINITY;
    if (element.readyState < HAVE_FUTURE_DATA) return 0;
    for (let index = 0; index < element.buffered.length; index += 1) {
      const rangeEnd = element.buffered.end(index);
      if (element.buffered.start(index) > position || rangeEnd <= position) continue;
      return rangeEnd >= end - END_TOLERANCE_SECONDS ? Number.POSITIVE_INFINITY : rangeEnd - position;
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
    this.element.volume = Math.max(0, Math.min(100, Math.round(volume))) / 100;
    this.element.muted = muted;
    return this.publish(active);
  }

  async selectAudioStream(sessionId: string, streamId: string): Promise<PlayerState> {
    const active = this.requireActive(sessionId);
    const tracks = this.element.audioTracks;
    const index = active.streams.findIndex((stream) => stream.id === streamId);
    if (tracks === undefined || index < 0) throw new Error("Audio stream is unavailable");
    for (let track = 0; track < tracks.length; track += 1) {
      const entry = tracks[track];
      if (entry !== undefined) entry.enabled = track === index;
    }
    active.selectedAudioStreamId = streamId;
    return this.publish(active);
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

  getState(): PlayerState | null {
    return this.active === null ? null : this.snapshot(this.active);
  }

  /** The state of a session that is still the one playing. */
  getActiveState(sessionId: string): PlayerState {
    return this.snapshot(this.requireActive(sessionId));
  }

  async stop(): Promise<void> {
    this.generation += 1;
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
    active.suspended = true;
    active.playingBeforeSuspend = !this.element.paused;
    this.element.pause();
    this.leaving = true;
    void active.reporter
      .saveProgress(this.snapshot(active))
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
  ): Promise<void> {
    const session = await this.api.startPlayback(itemId);
    const reporter = new PlaybackSessionReporter(this.sessionApi(), session.sessionId, () => {
      // A failed report is retried by the next one; it must not interrupt playback.
    });
    if (generation !== this.generation) {
      await reporter.end();
      throw cancelled();
    }
    try {
      this.assertAudioSupported(session.streams);
      await this.load(generation, session);
      // The element is shared: metadata may have arrived for a newer start's source.
      if (generation !== this.generation) throw cancelled();
    } catch (cause) {
      // Only the latest start owns the element. A replaced one must leave its successor's
      // source alone and just close the session it opened.
      if (generation === this.generation) this.unload();
      await reporter.end();
      throw cause;
    }
    const audioStreams = session.streams.filter((stream) => stream.kind === "audio");
    // Offer audio tracks only when the browser exposes exactly the tracks the server lists.
    const switchable =
      audioStreams.length > 1 && this.element.audioTracks?.length === audioStreams.length;
    const active: ActiveSession = {
      session,
      reporter,
      streams: switchable ? audioStreams : [],
      detach: () => undefined,
      selectedAudioStreamId: switchable
        ? ((audioStreams.find((stream) => stream.isDefault) ?? audioStreams[0])?.id ?? null)
        : null,
      buffering: false,
      awaitingInteraction: false,
      heldPlay: null,
      suspended: false,
      playingBeforeSuspend: false,
    };
    this.active = active;
    active.detach = this.attach(active);
    if (Number.isFinite(startAtSeconds) && startAtSeconds > 0)
      this.element.currentTime = startAtSeconds;
    try {
      if (!paused) await this.play(active);
    } catch (cause) {
      if (this.active === active) await this.stopActive({ saveProgress: false });
      throw cause;
    }
    if (this.active === active) this.publish(active);
  }

  /** Points the element at the media and waits until the browser can tell whether it will play. */
  private load(generation: number, session: PlayerSession): Promise<void> {
    // The grant authorises this one file for this one session. It appears only in the element's
    // source: never in state handed to the application, and never in anything that is stored.
    const url = new URL(session.streamUrl, this.api.serverOrigin);
    url.searchParams.set("grant", session.grantToken);
    return new Promise<void>((resolve, reject) => {
      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        clearInterval(watchdog);
        this.element.removeEventListener("loadedmetadata", onLoaded);
        this.element.removeEventListener("error", onError);
        outcome();
      };
      const onLoaded = (): void => settle(resolve);
      const onError = (): void =>
        settle(() => reject(describeMediaError(this.element.error?.code)));
      const timer = setTimeout(
        () => settle(() => reject(new Error("Timed out waiting for media to load"))),
        this.loadTimeoutMs,
      );
      // A newer start or stop abandons this load without waiting for the browser to give up.
      const watchdog = setInterval(() => {
        if (generation !== this.generation) settle(() => reject(cancelled()));
      }, 50);
      this.element.addEventListener("loadedmetadata", onLoaded);
      this.element.addEventListener("error", onError);
      this.element.src = url.toString();
      this.element.load();
    });
  }

  /** A file whose default audio the browser cannot decode would play silently; say so instead. */
  private assertAudioSupported(streams: ReadonlyArray<PlayableStream>): void {
    const audio = streams.filter((stream) => stream.kind === "audio");
    const first = audio.find((stream) => stream.isDefault) ?? audio[0];
    const probe = audioCodecProbes[first?.codec?.toLowerCase() ?? ""];
    if (probe !== undefined && this.element.canPlayType(probe) === "")
      throw new PlaybackUnsupportedError(
        `This browser can’t play this file’s ${first?.codec?.toUpperCase()} audio. Try another browser or the Lumen desktop app.`,
      );
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
      update();
    };
    const onWaiting = buffering(true);
    const onPlaying = buffering(false);
    const onError = (): void => {
      if (this.active === active) void this.recover(active, this.element.error?.code);
    };
    const onEnded = (): void => {
      update();
      void active.reporter.saveProgress(this.snapshot(active));
    };
    const listeners: ReadonlyArray<readonly [string, () => void]> = [
      ["timeupdate", update],
      ["durationchange", update],
      ["progress", update],
      ["play", update],
      ["pause", update],
      ["seeked", update],
      ["volumechange", update],
      ["waiting", onWaiting],
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
    return () => {
      clearInterval(timer);
      for (const [type, listener] of listeners) this.element.removeEventListener(type, listener);
    };
  }

  /** Playback broke after it had started. A lost connection is worth reopening; a bad file is not. */
  private async recover(active: ActiveSession, code: number | undefined): Promise<void> {
    const nowMs = Date.now();
    this.recoveries = this.recoveries.filter((at) => nowMs - at < RECOVERY_WINDOW_MS);
    if (code !== MEDIA_ERR_NETWORK || this.recoveries.length >= MAX_RECOVERIES) {
      await this.fail(describeMediaError(code));
      return;
    }
    this.recoveries.push(nowMs);
    await this.reopen(active);
  }

  /** Replaces a session the server no longer honours with a new one at the same position. */
  private async reopen(active: ActiveSession): Promise<void> {
    const { positionSeconds, paused } = this.snapshot(active);
    const wasPaused = active.suspended
      ? !active.playingBeforeSuspend
      : paused && !active.awaitingInteraction;
    const generation = ++this.generation;
    // The application keeps showing this playback while its session is replaced.
    await this.stopActive({ saveProgress: false, announce: false });
    if (generation !== this.generation) return;
    try {
      await this.open(generation, active.session.itemId, positionSeconds, wasPaused);
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
  }: { readonly saveProgress?: boolean; readonly announce?: boolean } = {}): Promise<void> {
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
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.element.playbackRate = 1;
  }

  private sessionApi(): PlaybackSessionApi {
    return {
      heartbeat: (sessionId, state) => this.api.heartbeat(sessionId, state),
      progress: (sessionId, state, sequence) =>
        this.api.progress(sessionId, state, sequence, { keepalive: this.leaving }),
      stopPlayback: (sessionId) => this.api.stopPlayback(sessionId, { keepalive: this.leaving }),
    };
  }

  private snapshot(active: ActiveSession): PlayerState {
    const { element } = this;
    const bufferedRanges = [];
    for (let index = 0; index < element.buffered.length; index += 1) {
      const startSeconds = element.buffered.start(index);
      const endSeconds = element.buffered.end(index);
      if (endSeconds > startSeconds) bufferedRanges.push({ startSeconds, endSeconds });
    }
    return {
      sessionId: active.session.sessionId,
      itemId: active.session.itemId,
      paused: element.paused,
      positionSeconds: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      durationSeconds:
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : active.session.durationSeconds,
      bufferedRanges,
      volume: Math.round(element.volume * 100),
      muted: element.muted,
      ended: element.ended,
      streams: active.streams,
      selectedAudioStreamId: active.selectedAudioStreamId,
      selectedSubtitleStreamId: null,
      // The browser decides the channel layout; this is the closest of the two descriptions.
      audioOutput: "auto-safe",
      buffering: active.buffering && !element.paused,
      awaitingInteraction: active.awaitingInteraction,
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
