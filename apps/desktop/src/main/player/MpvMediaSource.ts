import {
  originalFits,
  originalKbps,
  type PlaybackDiagnostics,
  qualityState,
  setTranscodingParameters,
  startingRendition,
  type ThroughputEstimator,
} from "@lumen/client";
import {
  ADAPTIVE_PIECE_SECONDS,
  type AdaptiveRendition,
  adaptiveRenditionsFor,
  type PlayerQuality,
  type PlayerSession,
  resolveTrackSelection,
  type TrackKind,
} from "@lumen/contracts";
import { ignoreFailure } from "../failures";
import { type MediaFile, type MediaSpec, mediaSpecOf } from "../media-store/MediaFile";
import type { MediaStore } from "../media-store/MediaStore";
import { AdaptiveStream } from "./AdaptiveStream";
import { startupRanges } from "./MediaPreload";
import type { MpvIpc } from "./MpvIpc";
import type { PlaybackBridge } from "./PlaybackBridge";
import type { PlaybackClient } from "./PlaybackClient";

export class MediaDecodeFailure extends Error {}
export class MediaLoadCancelled extends Error {}
export const isDecoderError = (message: string): boolean =>
  /error while decoding|failed to initialize.*decoder|could not open codec/i.test(message);
export const mediaFailure = (message: string): Error =>
  /decod|codec|file format|unrecognized format/i.test(message)
    ? new MediaDecodeFailure(message)
    : new Error(message);

export interface HeldMedia {
  readonly file: MediaFile;
  readonly release: () => void;
}

/**
 * Opens the file a session plays directly, with the session's grant to fill it, and starts
 * fetching what the player reads before its first frame, before the player asks for any of it.
 */
export const openHeldMedia = async (options: {
  readonly store: MediaStore;
  readonly client: PlaybackClient;
  readonly session: PlayerSession;
  readonly diagnostics: PlaybackDiagnostics;
  readonly startAtSeconds: number;
  /** Bytes of this file fetched before it played, held in memory, if any. */
  readonly takePreload?: (spec: MediaSpec) => ReadonlyMap<number, Buffer> | null;
}): Promise<HeldMedia | null> => {
  const { store, client, session, diagnostics } = options;
  const spec = mediaSpecOf(client.serverId, session.sourceId, session.media);
  if (spec === null) return null;
  const { file, release } = await store.acquire(spec);
  const preloaded = options.takePreload?.(spec) ?? null;
  if (preloaded !== null)
    diagnostics.record("preload_adopted", { bytes: await file.adoptMemory(preloaded) });
  if (session.durationSeconds !== null && session.durationSeconds > 0)
    file.bitrate = spec.sizeBytes / session.durationSeconds;
  const removeSource = client.offline
    ? () => undefined
    : file.addSource({
        origin: client.serverOrigin,
        path: session.streamUrl,
        token: session.grantToken,
        kind: "playback",
      });
  file.warm(startupRanges(spec.sizeBytes, session.durationSeconds, options.startAtSeconds));
  return {
    file,
    release: () => {
      removeSource();
      release();
    },
  };
};

/** What MPV plays: the file itself, a single conversion, or converted pieces from this quality. */
type Delivery = "original" | "converted" | AdaptiveRendition;

/**
 * MPV reads only this far ahead of converted pieces; the bridge holds the rest in memory. What
 * MPV has read can no longer be replaced, so a better quality reaches the screen this much sooner.
 */
const ADAPTIVE_CACHE_SECONDS = ADAPTIVE_PIECE_SECONDS;
const ORIGINAL_CACHE_SECONDS = 60;

/** Owns the current HTTP stream and translates the converted segment's clock to source time. */
export class MpvMediaSource {
  transcoded = false;
  /** Set while converted pieces play. */
  adaptive: AdaptiveStream | null = null;
  /** "auto", "original", or a rendition id. */
  qualityChoice = "auto";
  offset = 0;
  loading = false;
  interrupted = false;
  paused = true;
  audioId: string | null;
  subtitleId: string | null;
  trackIds = new Map<string, number>();
  private capability: string | null = null;
  private revision = 0;
  private loadAbort: AbortController | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly held: Promise<HeldMedia | null>;

  constructor(
    private readonly options: {
      ipc: MpvIpc;
      bridge: PlaybackBridge;
      client: PlaybackClient;
      session: PlayerSession;
      connectionId: string;
      diagnostics: PlaybackDiagnostics;
      active: () => boolean;
      /** The file as this device holds it; without it every stream is proxied as it arrives. */
      held?: Promise<HeldMedia | null>;
      /** Measures the connection across playbacks from the same server. */
      estimator: ThroughputEstimator;
    },
  ) {
    this.held = options.held ?? Promise.resolve(null);
    void this.held.then((held) => {
      if (this.closed || held === null) return;
      this.heldFile = held.file;
      // The original's fetches measure the link while it plays, at the file's average bitrate.
      held.file.on("throughput", (bytes: number, milliseconds: number) => {
        const kbps = this.originalKbps;
        if (kbps !== null && this.playsOriginal)
          options.estimator.sample(bytes, milliseconds, (bytes * 8) / 1000 / kbps);
      });
    }, ignoreFailure);
    const selected = resolveTrackSelection(
      options.session.streams,
      options.session.sourceId,
      options.session.trackMemory,
    );
    this.audioId = selected.audio?.id ?? null;
    this.subtitleId = selected.subtitle?.id ?? null;
  }

  get ready() {
    return !this.loading && !this.interrupted;
  }

  get streams() {
    return this.transcoded || this.adaptive !== null
      ? this.options.session.streams.filter((stream) => stream.kind === "audio")
      : this.options.session.streams.filter((stream) => this.trackIds.has(stream.id));
  }

  /** The qualities the server converts this file into; none where it cannot, or need not. */
  get renditions(): ReadonlyArray<AdaptiveRendition> {
    const { client, session } = this.options;
    // Bytes kept on this device play as they are: there is nothing to adapt to.
    if (
      client.supportsAdaptive !== true ||
      client.offline === true ||
      !session.media?.video ||
      this.conversionFailed
    )
      return [];
    if (this.heldFile?.complete === true) return [];
    return adaptiveRenditionsFor(session.media.video.size?.height ?? null);
  }

  get originalKbps(): number | null {
    return originalKbps(
      this.options.session.media?.sizeBytes,
      this.options.session.durationSeconds,
    );
  }

  /** Whether the original file can play at all; false once MPV failed to decode it. */
  private originalPlays = true;
  /** Set once converted pieces failed to start, as when the server has conversion turned off. */
  private conversionFailed = false;

  quality(): PlayerQuality | undefined {
    const renditions = this.renditions;
    // A file MPV cannot decode plays as one conversion, which has no qualities to offer.
    if (renditions.length === 0 || !this.originalPlays) return undefined;
    return qualityState({
      choice: this.qualityChoice,
      playing: this.adaptive?.playingRendition.id ?? "original",
      original: {
        height: this.options.session.media?.video?.size?.height ?? null,
        kbps: this.originalKbps,
      },
      renditions,
      measuredKbps: this.options.estimator.kbps,
    });
  }

  async start(position: number): Promise<void> {
    await this.held.catch(() => null);
    const delivery = this.startingDelivery();
    try {
      await this.load(delivery, position).catch((cause: unknown) => {
        if (typeof delivery !== "object" || cause instanceof MediaLoadCancelled) throw cause;
        // Conversion can be off on a server that offers it; the original still plays.
        this.conversionFailed = true;
        return this.load("original", position);
      });
    } catch (cause) {
      if (!(cause instanceof MediaDecodeFailure)) throw cause;
      await this.convert(position);
    }
  }

  /** Where Auto starts, or the viewer's own choice. */
  private startingDelivery(): Delivery {
    const renditions = this.renditions;
    if (renditions.length === 0 || this.qualityChoice === "original") return "original";
    const chosen = renditions.find((rendition) => rendition.id === this.qualityChoice);
    if (chosen !== undefined) return chosen;
    if (this.originalPlays && originalFits(this.options.estimator.kbps, this.originalKbps))
      return "original";
    return startingRendition(renditions, this.options.estimator.kbps) ?? "original";
  }

  /** The original failed to decode: the server converts it as one stream from `position`. */
  convert(position: number): Promise<void> {
    if (!this.options.client.supportsTranscoding)
      return Promise.reject(
        new Error(
          "This server does not support transcoding. Update the server to play this media.",
        ),
      );
    this.originalPlays = false;
    return this.load("converted", position);
  }

  /**
   * Swaps between the original and converted pieces at a position: a brief reload. When
   * converted pieces fail to start, the original plays on and they are no longer offered.
   */
  switchTo(delivery: "original" | AdaptiveRendition, position: number): Promise<void> {
    return this.load(delivery, position).catch((cause: unknown) => {
      if (delivery === "original" || cause instanceof MediaLoadCancelled || !this.originalPlays)
        throw cause;
      this.conversionFailed = true;
      this.qualityChoice = "auto";
      return this.load("original", position);
    });
  }

  get playsOriginal(): boolean {
    return this.adaptive === null && !this.transcoded;
  }

  get originalUsable(): boolean {
    return this.originalPlays;
  }

  /** "auto", "original", or a rendition id. */
  async selectQuality(choice: string, position: number): Promise<void> {
    const rendition = this.renditions.find((candidate) => candidate.id === choice);
    if (choice !== "auto" && rendition === undefined && choice !== "original")
      throw new Error("Quality is unavailable");
    if (choice === "original" && !this.originalPlays)
      throw new Error("This file needs converting to play here");
    this.qualityChoice = choice;
    if (choice === "original" && !this.playsOriginal) await this.load("original", position);
    else if (rendition !== undefined && this.adaptive === null)
      await this.switchTo(rendition, position);
    else this.adaptive?.choose(choice);
  }

  async select(kind: TrackKind, streamId: string | null, position: number): Promise<void> {
    if (kind === "subtitle" && (this.transcoded || this.adaptive !== null) && streamId !== null)
      throw new Error("Subtitles are unavailable during server transcoding");
    if (kind === "audio" && (this.transcoded || this.adaptive !== null)) {
      this.audioId = streamId;
      try {
        await this.load(this.adaptive?.loadingRendition ?? "converted", position);
      } catch (cause) {
        if (!(cause instanceof MediaLoadCancelled)) throw cause;
        await this.waitForReplacement();
      }
      return;
    }
    const trackId = streamId === null ? "no" : this.trackIds.get(streamId);
    if (trackId === undefined) throw new Error("Stream is unavailable");
    if (kind === "audio") this.audioId = streamId;
    await this.options.ipc.command(["set_property", kind === "audio" ? "aid" : "sid", trackId]);
    if (kind === "audio") {
      try {
        await this.checkDecoders();
      } catch (cause) {
        if (!(cause instanceof MediaDecodeFailure)) throw cause;
        await this.convert(position);
      }
    } else this.subtitleId = streamId;
  }

  private async waitForReplacement(): Promise<void> {
    for (;;) {
      const pending = this.tail;
      try {
        await pending;
      } catch (cause) {
        if (pending === this.tail || !(cause instanceof MediaLoadCancelled)) throw cause;
      }
      if (this.closed || !this.options.active())
        throw new MediaLoadCancelled("Playback request was cancelled");
      if (pending === this.tail) return;
    }
  }

  suspend(): void {
    this.interrupted = true;
    if (this.capability !== null) this.options.bridge.revoke(this.capability);
  }

  close(): void {
    this.closed = true;
    this.revision += 1;
    this.loadAbort?.abort();
    this.adaptive?.close();
    this.adaptive = null;
    if (this.capability !== null) this.options.bridge.revoke(this.capability);
    this.heldFile = null;
    // A file that failed to open was reported by the load that awaited it.
    void this.held.then((held) => held?.release(), ignoreFailure);
  }

  /** The file as this device holds it, once it is open. */
  heldFile: MediaFile | null = null;

  private load(delivery: Delivery, position: number): Promise<void> {
    const converted = delivery === "converted";
    const adaptiveRendition = typeof delivery === "object" ? delivery : null;
    const revision = ++this.revision;
    this.transcoded = converted;
    this.interrupted = false;
    this.loading = true;
    this.loadAbort?.abort();
    if (this.capability !== null) this.options.bridge.revoke(this.capability);
    let loadFailure: Error | null = null;
    let detach = () => {};
    const assertCurrent = () => {
      if (this.closed || revision !== this.revision || !this.options.active())
        throw new MediaLoadCancelled("Playback request was cancelled");
      if (loadFailure !== null) throw loadFailure;
    };
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        assertCurrent();
        const abort = new AbortController();
        this.loadAbort = abort;
        const { ipc, bridge, client, session } = this.options;
        await ipc.command(["stop"]);
        assertCurrent();
        const url = new URL(session.streamUrl, client.serverOrigin);
        const offset = converted ? position : 0;
        const audios = session.streams
          .filter((stream) => stream.kind === "audio")
          .sort((a, b) => a.ordinal - b.ordinal);
        const audioIndex = Math.max(
          0,
          audios.findIndex((stream) => stream.id === this.audioId),
        );
        this.adaptive?.close();
        this.adaptive = null;
        let adaptive: AdaptiveStream | null = null;
        if (adaptiveRendition !== null) {
          adaptive = new AdaptiveStream({
            serverOrigin: client.serverOrigin,
            basePath: `${url.pathname}/adaptive/${audioIndex}`,
            bearer: session.grantToken,
            renditions: this.renditions,
            start: adaptiveRendition,
            choice: this.qualityChoice,
            startSeconds: position,
            estimator: this.options.estimator,
            diagnostics: this.options.diagnostics,
          });
          try {
            await adaptive.open();
          } catch (cause) {
            adaptive.close();
            throw cause;
          }
          if (this.closed || revision !== this.revision) adaptive.close();
          assertCurrent();
          this.adaptive = adaptive;
        }
        await ipc.command([
          "set_property",
          "cache-secs",
          adaptive === null ? ORIGINAL_CACHE_SECONDS : ADAPTIVE_CACHE_SECONDS,
        ]);
        assertCurrent();
        if (converted) {
          setTranscodingParameters(
            url,
            {
              format: "mp4",
              video: session.media?.video === null ? "none" : "h264",
              audio: "aac",
              audioIndex,
            },
            position,
          );
        }
        let transferError: Error | null = null;
        const held = converted || adaptive !== null ? null : await this.held;
        assertCurrent();
        if (held === null && client.offline)
          throw new Error("This item needs the server, which cannot be reached");
        const onHeldFailure = (cause: Error) => {
          transferError = cause;
        };
        held?.file.on("failure", onHeldFailure);
        const detachHeld = () => held?.file.off("failure", onHeldFailure);
        detach = detachHeld;
        const registered =
          adaptive !== null
            ? bridge.register({
                adaptive,
                active: () => !this.closed && this.options.active(),
              })
            : held === null
              ? bridge.register({
                  onStatus: (status) => {
                    if (status >= 400)
                      transferError = new Error(
                        converted
                          ? `Server transcoding is unavailable (HTTP ${status}). Check server settings and capacity.`
                          : `Media request failed (HTTP ${status})`,
                      );
                  },
                  connectionId: this.options.connectionId,
                  serverOrigin: client.serverOrigin,
                  streamPath: url.pathname + url.search,
                  bearer: session.grantToken,
                  active: () => !this.closed && this.options.active(),
                  sessionId: session.sessionId,
                  diagnostics: this.options.diagnostics,
                })
              : bridge.register({
                  file: held.file,
                  active: () => !this.closed && this.options.active(),
                  sessionId: session.sessionId,
                  diagnostics: this.options.diagnostics,
                });
        this.capability = registered.capability;
        await ipc.command(["set_property", "pause", "yes"]);
        assertCurrent();
        let decoderError: MediaDecodeFailure | null = null;
        let fileLoaded = false;
        const loaded = new Promise<void>((resolve, reject) => {
          const onLoaded = () => {
            fileLoaded = true;
            clearTimeout(timer);
            resolve();
          };
          const onEnd = (event: { reason?: string; file_error?: string }) => {
            if (event.reason !== "error") return;
            loadFailure =
              transferError ??
              decoderError ??
              mediaFailure(event.file_error ?? "Media load failed");
            reject(loadFailure);
          };
          const onLog = (event: { text?: string }) => {
            if (isDecoderError(event.text ?? "")) {
              decoderError = new MediaDecodeFailure("MPV could not decode the media");
              if (fileLoaded) loadFailure = decoderError;
            }
          };
          const onAbort = () => reject(new MediaLoadCancelled("Playback request was cancelled"));
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for media to load")),
            25000,
          );
          detach = () => {
            detachHeld();
            clearTimeout(timer);
            ipc.off("file-loaded", onLoaded);
            ipc.off("end-file", onEnd);
            ipc.off("log-message", onLog);
            abort.signal.removeEventListener("abort", onAbort);
          };
          ipc.on("file-loaded", onLoaded);
          ipc.on("end-file", onEnd);
          ipc.on("log-message", onLog);
          abort.signal.addEventListener("abort", onAbort, { once: true });
        });
        void loaded.catch(() => {});
        await ipc.command(["loadfile", registered.url, "replace"]);
        await loaded;
        assertCurrent();
        this.transcoded = converted;
        this.offset = offset;
        const tracks = await ipc.command(["get_property", "track-list"]);
        assertCurrent();
        this.trackIds.clear();
        if (Array.isArray(tracks))
          for (const track of tracks) {
            if (track === null || typeof track !== "object" || typeof track.id !== "number")
              continue;
            if (track.type !== "audio" && track.type !== "sub") continue;
            const stream =
              converted || adaptive !== null
                ? session.streams.find(
                    (stream) => stream.id === this.audioId && track.type === "audio",
                  )
                : session.streams.find(
                    (stream) =>
                      stream.ordinal === track["ff-index"] &&
                      stream.kind === (track.type === "audio" ? "audio" : "subtitle"),
                  );
            if (stream) this.trackIds.set(stream.id, track.id);
          }
        if (converted || adaptive !== null) this.subtitleId = null;
        for (const [kind, streamId] of [
          ["audio", this.audioId],
          ["sub", this.subtitleId],
        ] as const) {
          const desired = streamId === null ? "no" : (this.trackIds.get(streamId) ?? "no");
          const selected = Array.isArray(tracks)
            ? (tracks.find((track) => track?.type === kind && track.selected === true)?.id ?? "no")
            : "no";
          if (selected !== desired)
            await ipc.command(["set_property", kind === "audio" ? "aid" : "sid", desired]);
          assertCurrent();
        }
        await this.checkDecoders();
        assertCurrent();
        if (!converted && position > 0) await ipc.command(["seek", position, "absolute+exact"]);
        assertCurrent();
        let appliedPause: boolean;
        do {
          appliedPause = this.paused;
          await ipc.command(["set_property", "pause", appliedPause ? "yes" : "no"]);
          assertCurrent();
        } while (appliedPause !== this.paused);
        this.options.diagnostics.record("media_delivery", {
          transcoded: converted,
          adaptive: adaptiveRendition?.id ?? null,
          startSeconds: position,
        });
      })
      .catch((cause) => {
        if (this.revision === revision && this.capability !== null)
          this.options.bridge.revoke(this.capability);
        throw cause;
      })
      .finally(() => {
        detach();
        if (this.revision === revision) this.loading = false;
      });
    this.tail = task;
    return task;
  }

  private async checkDecoders(): Promise<void> {
    const { ipc, session } = this.options;
    const property = (name: string) =>
      ipc.command(["get_property", name]).catch((cause) => {
        if (cause instanceof Error && cause.message.includes("property unavailable")) return null;
        throw cause;
      });
    if (session.media?.video && !(await property("video-codec")))
      throw new MediaDecodeFailure("MPV cannot decode this video");
    if (this.audioId !== null && !(await property("audio-codec-name")))
      throw new MediaDecodeFailure("MPV cannot decode this audio");
  }
}
