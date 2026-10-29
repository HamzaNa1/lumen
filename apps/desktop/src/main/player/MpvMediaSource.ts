import { type PlaybackDiagnostics, setTranscodingParameters } from "@lumen/client";
import { type PlayerSession, resolveTrackSelection, type TrackKind } from "@lumen/contracts";
import type { ServerClient } from "../api/ServerClient";
import type { MpvIpc } from "./MpvIpc";
import type { PlaybackBridge } from "./PlaybackBridge";

export class MediaDecodeFailure extends Error {}
export class MediaLoadCancelled extends Error {}
export const isDecoderError = (message: string): boolean =>
  /error while decoding|failed to initialize.*decoder|could not open codec/i.test(message);
export const mediaFailure = (message: string): Error =>
  /decod|codec|file format|unrecognized format/i.test(message)
    ? new MediaDecodeFailure(message)
    : new Error(message);

/** Owns the current HTTP stream and translates the converted segment's clock to source time. */
export class MpvMediaSource {
  transcoded = false;
  offset = 0;
  loading = false;
  paused = true;
  audioId: string | null;
  subtitleId: string | null;
  trackIds = new Map<string, number>();
  private capability: string | null = null;
  private revision = 0;
  private loadAbort: AbortController | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly options: {
      ipc: MpvIpc;
      bridge: PlaybackBridge;
      client: ServerClient;
      session: PlayerSession;
      connectionId: string;
      diagnostics: PlaybackDiagnostics;
      active: () => boolean;
    },
  ) {
    const selected = resolveTrackSelection(
      options.session.streams,
      options.session.sourceId,
      options.session.trackMemory,
    );
    this.audioId = selected.audio?.id ?? null;
    this.subtitleId = selected.subtitle?.id ?? null;
  }

  get streams() {
    return this.transcoded
      ? this.options.session.streams.filter((stream) => stream.kind === "audio")
      : this.options.session.streams.filter((stream) => this.trackIds.has(stream.id));
  }

  async start(position: number): Promise<void> {
    try {
      await this.load(false, position);
    } catch (cause) {
      if (!(cause instanceof MediaDecodeFailure)) throw cause;
      await this.convert(position);
    }
  }

  convert(position: number): Promise<void> {
    if (!this.options.client.supportsTranscoding)
      return Promise.reject(
        new Error(
          "This server does not support transcoding. Update the server to play this media.",
        ),
      );
    return this.load(true, position);
  }

  async select(kind: TrackKind, streamId: string | null, position: number): Promise<void> {
    if (kind === "subtitle" && this.transcoded && streamId !== null)
      throw new Error("Subtitles are unavailable during server transcoding");
    if (kind === "audio" && this.transcoded) {
      this.audioId = streamId;
      await this.convert(position);
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

  close(): void {
    this.closed = true;
    this.revision += 1;
    this.loadAbort?.abort();
    if (this.capability !== null) this.options.bridge.revoke(this.capability);
  }

  private load(converted: boolean, position: number): Promise<void> {
    const revision = ++this.revision;
    this.transcoded = converted;
    this.loading = true;
    this.loadAbort?.abort();
    if (this.capability !== null) this.options.bridge.revoke(this.capability);
    const assertCurrent = () => {
      if (this.closed || revision !== this.revision || !this.options.active())
        throw new MediaLoadCancelled("Playback request was cancelled");
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
        if (converted) {
          const audios = session.streams
            .filter((stream) => stream.kind === "audio")
            .sort((a, b) => a.ordinal - b.ordinal);
          setTranscodingParameters(
            url,
            {
              format: "mp4",
              video: session.media?.video === null ? "none" : "h264",
              audio: "aac",
              audioIndex: Math.max(
                0,
                audios.findIndex((stream) => stream.id === this.audioId),
              ),
            },
            position,
          );
        }
        let transferError: Error | null = null;
        const registered = bridge.register({
          onStatus: (status) => {
            if (status >= 400)
              transferError = new Error(
                converted
                  ? `Server transcoding is unavailable (HTTP ${status}). Check server settings and capacity.`
                  : `Media request failed (HTTP ${status})`,
              );
          },
          connectionId: this.options.connectionId,
          serverClient: client,
          streamPath: url.pathname + url.search,
          bearer: session.grantToken,
          active: () => !this.closed && this.options.active(),
          sessionId: session.sessionId,
          diagnostics: this.options.diagnostics,
        });
        this.capability = registered.capability;
        await ipc.command(["set_property", "pause", "yes"]);
        assertCurrent();
        let decoderError: MediaDecodeFailure | null = null;
        let detach = () => {};
        const loaded = new Promise<void>((resolve, reject) => {
          const finish = (cause?: unknown) => {
            detach();
            cause ? reject(cause) : resolve();
          };
          const onLoaded = () => finish();
          const onEnd = (event: { reason?: string; file_error?: string }) => {
            if (event.reason === "error")
              finish(
                transferError ??
                  decoderError ??
                  mediaFailure(event.file_error ?? "Media load failed"),
              );
          };
          const onLog = (event: { text?: string }) => {
            if (isDecoderError(event.text ?? ""))
              decoderError = new MediaDecodeFailure("MPV could not decode the media");
          };
          const onAbort = () => finish(new MediaLoadCancelled("Playback request was cancelled"));
          const timer = setTimeout(
            () => finish(new Error("Timed out waiting for media to load")),
            25000,
          );
          detach = () => {
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
        try {
          await ipc.command(["loadfile", registered.url, "replace"]);
          await loaded;
        } finally {
          detach();
        }
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
            const stream = converted
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
        if (converted) this.subtitleId = null;
        await ipc.command([
          "set_property",
          "aid",
          this.audioId === null ? "no" : (this.trackIds.get(this.audioId) ?? "no"),
        ]);
        assertCurrent();
        await ipc.command([
          "set_property",
          "sid",
          this.subtitleId === null ? "no" : (this.trackIds.get(this.subtitleId) ?? "no"),
        ]);
        assertCurrent();
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
          startSeconds: position,
        });
      })
      .catch((cause) => {
        if (this.revision === revision && this.capability !== null)
          this.options.bridge.revoke(this.capability);
        throw cause;
      })
      .finally(() => {
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
