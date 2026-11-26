import { resolveTrackSelection } from "@lumen/contracts";
import { Effect } from "effect";
import { ServerError } from "../core/Errors";
import type { MediaToolkit } from "../http/MountedRouter";
import type { AuthPrincipal } from "../services/AuthService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import { fromJellyfinId, millisFromTicks } from "./Ids";
import type { PlaybackReport } from "./Schemas";

interface PlayingStream {
  readonly id: string;
  readonly kind: "video" | "audio" | "subtitle";
  readonly ordinal: number;
}

/** One Jellyfin playback, kept until the app stops it or its device starts another. */
interface Playing {
  readonly playSessionId: string;
  readonly userId: string;
  readonly itemId: string;
  /** The Lumen playback session that records progress; replaced if that session lapses. */
  lumenSessionId: string;
  sequence: number;
  readonly durationMs: number | null;
  readonly streams: ReadonlyArray<PlayingStream>;
  /** The tracks as last chosen, so only a change is remembered as the viewer's choice. */
  audio: number | null;
  subtitle: number | null;
}

/**
 * The key a playback and its media requests are kept under. The viewer's ID is part of it, so a
 * play session ID guessed from another account never reaches that account's playback or encoder.
 */
export const mediaKey = (userId: string, playSessionId: string) => `${userId}-${playSessionId}`;

const call = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const closed = (cause: unknown) =>
  cause instanceof ServerError && (cause.code === "conflict" || cause.code === "not_found");

export class Reporting {
  private readonly playing = new Map<string, Playing>();
  /** The play session each device is on; a device plays one thing at a time. */
  private readonly byDevice = new Map<string, string>();

  constructor(
    private readonly playback: PlaybackServiceShape,
    private readonly media: MediaToolkit,
  ) {}

  private async replace(principal: AuthPrincipal, entry: Playing) {
    const previous = this.byDevice.get(principal.deviceId);
    if (previous !== undefined && previous !== entry.playSessionId)
      await this.end(principal, previous);
    this.playing.set(mediaKey(entry.userId, entry.playSessionId), entry);
    this.byDevice.set(principal.deviceId, entry.playSessionId);
  }

  /** Records the playback PlaybackInfo started, ending whatever the device played before. */
  begin(
    principal: AuthPrincipal,
    lumenSessionId: string,
    entry: Pick<Playing, "itemId" | "durationMs" | "streams" | "audio" | "subtitle">,
  ) {
    return this.replace(principal, {
      ...entry,
      playSessionId: lumenSessionId,
      userId: principal.user.id,
      lumenSessionId,
      sequence: 0,
    });
  }

  async end(principal: AuthPrincipal, playSessionId: string) {
    const key = mediaKey(principal.user.id, playSessionId);
    const entry = this.playing.get(key);
    this.playing.delete(key);
    if (this.byDevice.get(principal.deviceId) === playSessionId)
      this.byDevice.delete(principal.deviceId);
    this.media.adaptiveStreams.stop(key, principal.user.id);
    this.media.transcoder.stop(key, principal.user.id);
    await call(
      this.playback.stop(principal, entry?.lumenSessionId ?? playSessionId, Date.now()),
    ).catch(() => {});
  }

  stopEncoding(principal: AuthPrincipal, playSessionId: string | null) {
    const id = playSessionId ?? this.byDevice.get(principal.deviceId);
    if (id === undefined) return;
    this.media.adaptiveStreams.stop(mediaKey(principal.user.id, id), principal.user.id);
    this.media.transcoder.stop(mediaKey(principal.user.id, id), principal.user.id);
  }

  /** The playback a report belongs to. One the server no longer knows, as after a restart, restarts. */
  private async resolve(principal: AuthPrincipal, report: PlaybackReport) {
    const playSessionId =
      fromJellyfinId(report.PlaySessionId) ?? this.byDevice.get(principal.deviceId) ?? null;
    if (playSessionId === null) return null;
    const itemId = fromJellyfinId(report.ItemId);
    const known = this.playing.get(mediaKey(principal.user.id, playSessionId));
    if (known !== undefined && (itemId === null || known.itemId === itemId)) return known;
    if (itemId === null) return null;
    if (known !== undefined)
      await call(this.playback.stop(principal, known.lumenSessionId, Date.now())).catch(() => {});
    const started = await call(this.playback.start(principal, { trackId: itemId }, Date.now()));
    const selected = resolveTrackSelection(started.streams, started.sourceId, started.trackMemory);
    const entry: Playing = {
      playSessionId,
      userId: principal.user.id,
      itemId,
      lumenSessionId: started.session.id,
      sequence: 0,
      durationMs: started.durationSeconds === null ? null : started.durationSeconds * 1000,
      streams: started.streams,
      audio: selected.audio?.ordinal ?? null,
      subtitle: selected.subtitle?.ordinal ?? -1,
    };
    await this.replace(principal, entry);
    return entry;
  }

  private async keepAlive(principal: AuthPrincipal, entry: Playing, paused: boolean) {
    const heartbeat = () =>
      call(
        this.playback.heartbeat(
          principal,
          entry.lumenSessionId,
          { state: paused ? "paused" : "playing", activeTrackId: entry.itemId },
          Date.now(),
        ),
      );
    try {
      await heartbeat();
    } catch (cause) {
      // A Lumen session lapses after an hour without reports; the app's playback carries on.
      if (!closed(cause)) throw cause;
      const started = await call(
        this.playback.start(principal, { trackId: entry.itemId }, Date.now()),
      );
      entry.lumenSessionId = started.session.id;
      entry.sequence = 0;
      await heartbeat();
    }
  }

  private async remember(principal: AuthPrincipal, entry: Playing, report: PlaybackReport) {
    const choices: Array<{ kind: "audio" | "subtitle"; index: number | null }> = [];
    const audio = report.AudioStreamIndex;
    const subtitle = report.SubtitleStreamIndex;
    if (audio != null && audio >= 0 && audio !== entry.audio)
      choices.push({ kind: "audio", index: audio });
    if (subtitle != null && subtitle !== entry.subtitle)
      choices.push({ kind: "subtitle", index: subtitle < 0 ? null : subtitle });
    for (const choice of choices) {
      const stream =
        choice.index === null
          ? null
          : entry.streams.find(
              (candidate) => candidate.kind === choice.kind && candidate.ordinal === choice.index,
            );
      if (stream === undefined) continue;
      const saved = await call(
        this.playback.saveChoice(
          principal,
          entry.lumenSessionId,
          { kind: choice.kind, choice: stream === null ? "off" : stream.id },
          Date.now(),
        ),
      ).then(
        () => true,
        (cause: unknown) => {
          if (closed(cause)) return false;
          throw cause;
        },
      );
      if (!saved) continue;
      if (choice.kind === "audio") entry.audio = choice.index;
      else entry.subtitle = choice.index ?? -1;
    }
  }

  private async progress(principal: AuthPrincipal, entry: Playing, report: PlaybackReport) {
    if (report.PositionTicks == null) return;
    const position = millisFromTicks(report.PositionTicks);
    entry.sequence += 1;
    await call(
      this.playback.progress(
        principal,
        entry.lumenSessionId,
        {
          trackId: entry.itemId,
          positionMs: entry.durationMs === null ? position : Math.min(position, entry.durationMs),
          durationMs: entry.durationMs,
          sequence: entry.sequence,
        },
        Date.now(),
      ),
    );
  }

  /** Remembers the tracks a PlaybackInfo request named, when they differ from the defaults. */
  async choose(principal: AuthPrincipal, playSessionId: string, report: PlaybackReport) {
    const entry = this.playing.get(mediaKey(principal.user.id, playSessionId));
    if (entry !== undefined) await this.remember(principal, entry, report);
  }

  /** `Sessions/Playing` and `Sessions/Playing/Progress`. */
  async report(principal: AuthPrincipal, report: PlaybackReport) {
    const entry = await this.resolve(principal, report);
    if (entry === null) return;
    await this.keepAlive(principal, entry, report.IsPaused === true);
    await this.progress(principal, entry, report);
    await this.remember(principal, entry, report);
  }

  /** `Sessions/Playing/Ping`: the app is still there, nothing else changed. */
  async ping(principal: AuthPrincipal, playSessionId: string | null) {
    const entry = await this.resolve(principal, { PlaySessionId: playSessionId });
    if (entry !== null) await this.keepAlive(principal, entry, false);
  }

  /** `Sessions/Playing/Stopped`: the last position, then the session and its encoder end. */
  async stopped(principal: AuthPrincipal, report: PlaybackReport) {
    const entry = await this.resolve(principal, report);
    if (entry === null) return;
    if (report.Failed !== true) await this.progress(principal, entry, report).catch(() => {});
    await this.end(principal, entry.playSessionId);
  }
}
