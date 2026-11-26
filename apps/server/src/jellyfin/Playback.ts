import { stat } from "node:fs/promises";
import { canEncodeAdaptiveVideo, resolveTrackSelection } from "@lumen/contracts";
import { Effect } from "effect";
import { badRequest, notFound } from "../core/Errors";
import type { MediaToolkit } from "../http/MountedRouter";
import type { AuthPrincipal } from "../services/AuthService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import type { TranscodingSettingsShape } from "../services/TranscodingSettings";
import { accessToken } from "./Auth";
import { fromJellyfinId, toJellyfinId } from "./Ids";
import { mediaSourceInfo, mediaStream, sourceBitrate } from "./Items";
import { decidePlayback, isTextSubtitle, type SubtitleFormat } from "./PlaybackDecision";
import type { VideoProbe } from "./Probe";
import type { Queries } from "./Queries";
import { mediaKey, type Reporting } from "./Reporting";
import type { DeviceProfile, PlaybackInfoBody } from "./Schemas";
import { type SubtitleExtractor, subtitleMimeTypes } from "./Subtitles";

const call = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

export interface PlaybackContext {
  readonly request: Request;
  readonly query: (name: string) => string | null;
  readonly principal: AuthPrincipal;
}

const integer = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const flag = (value: string | null): boolean | null =>
  value === null ? null : value.toLowerCase() === "true";

export const makePlayback = (dependencies: {
  readonly playback: PlaybackServiceShape;
  readonly transcodingSettings: TranscodingSettingsShape;
  readonly queries: Queries;
  readonly reporting: Reporting;
  readonly media: MediaToolkit;
  readonly subtitles: SubtitleExtractor;
  readonly probe: VideoProbe;
}) => {
  const { playback, queries, reporting, media, subtitles } = dependencies;

  /** The play session a media request names, or the sign-in when it names none. */
  const sessionKey = (context: PlaybackContext) =>
    mediaKey(
      context.principal.user.id,
      fromJellyfinId(context.query("playSessionId")) ?? context.principal.sessionId,
    );

  const credentials = (context: PlaybackContext, playSessionId: string) => {
    const token = accessToken(context.request, context.query) ?? "";
    return `api_key=${encodeURIComponent(token)}&PlaySessionId=${playSessionId}`;
  };

  const playbackInfo = async (
    context: PlaybackContext,
    itemId: string,
    body: typeof PlaybackInfoBody.Type,
  ) => {
    const { principal, query } = context;
    const item = await call(queries.item(principal, itemId, Date.now()));
    if (item === null || (item.kind !== "movie" && item.kind !== "episode"))
      throw notFound("Item not found");
    const started = await call(playback.start(principal, { trackId: itemId }, Date.now()));
    const stopUnused = () => call(playback.stop(principal, started.session.id, Date.now()));
    const source = await call(queries.source(itemId, started.sourceId));
    if (source === null) {
      await stopUnused();
      throw notFound("Item not found");
    }
    const selection = resolveTrackSelection(started.streams, started.sourceId, started.trackMemory);
    const audioIndex =
      integer(query("audioStreamIndex")) ?? body.AudioStreamIndex ?? selection.audio?.ordinal;
    const requestedSubtitle = integer(query("subtitleStreamIndex")) ?? body.SubtitleStreamIndex;
    const subtitleIndex = requestedSubtitle ?? selection.subtitle?.ordinal ?? -1;
    const audios = source.streams.filter((stream) => stream.kind === "audio");
    const audio = audios.find((stream) => stream.ordinal === audioIndex) ?? audios[0] ?? null;
    const video = source.streams.find((stream) => stream.kind === "video") ?? null;
    const file = await call(playback.authorizeTrack(principal, itemId, Date.now())).catch(
      async (cause: unknown) => {
        await stopUnused();
        throw cause;
      },
    );
    const details = video === null ? null : await dependencies.probe.details(file);
    const describe = (
      stream: (typeof source.streams)[number],
      delivery?: Parameters<typeof mediaStream>[1],
    ) => mediaStream(stream, delivery, stream.kind === "video" ? details : null);
    const transcoding = await call(dependencies.transcodingSettings.read());
    const profile: DeviceProfile | null = body.DeviceProfile ?? null;
    const decision = decidePlayback({
      container: source.container,
      bitrate: sourceBitrate(source),
      video: video === null ? null : { ...video, details },
      audio,
      subtitles: source.streams
        .filter((stream) => stream.kind === "subtitle")
        .map((stream) => ({ index: stream.ordinal, codec: stream.codec })),
      profile,
      maxStreamingBitrate:
        integer(query("maxStreamingBitrate")) ?? body.MaxStreamingBitrate ?? null,
      enableDirectPlay: flag(query("enableDirectPlay")) ?? body.EnableDirectPlay ?? true,
      enableTranscoding: flag(query("enableTranscoding")) ?? body.EnableTranscoding ?? true,
      canConvert: canEncodeAdaptiveVideo(transcoding),
    });
    const jellyfinId = toJellyfinId(itemId);
    if (decision.kind === "NoCompatibleStream") {
      await stopUnused();
      return {
        MediaSources: [
          {
            ...mediaSourceInfo(
              itemId,
              item.title,
              source,
              source.streams.map((stream) => describe(stream)),
            ),
            SupportsDirectPlay: false,
          },
        ],
        ErrorCode: "NoCompatibleStream",
      };
    }
    const playSessionId = toJellyfinId(started.session.id);
    const auth = credentials(context, playSessionId);
    const streams = source.streams.map((stream) => {
      const plan = stream.kind === "subtitle" ? decision.subtitles.get(stream.ordinal) : undefined;
      if (plan === undefined) return describe(stream);
      return describe(stream, {
        method: plan.method,
        ...(plan.method === "External" && plan.format !== undefined
          ? {
              url: `/Videos/${jellyfinId}/${jellyfinId}/Subtitles/${stream.ordinal}/0/Stream.${plan.format}?${auth}`,
            }
          : {}),
      });
    });
    const audioPosition = audio === null ? 0 : audios.indexOf(audio);
    await reporting.begin(principal, started.session.id, {
      itemId,
      durationMs: started.durationSeconds === null ? null : started.durationSeconds * 1000,
      streams: source.streams.map((stream) => ({
        id: stream.id,
        kind: stream.kind,
        ordinal: stream.ordinal,
      })),
      audio: selection.audio?.ordinal ?? audios[0]?.ordinal ?? null,
      subtitle: selection.subtitle?.ordinal ?? -1,
    });
    // Apps switch tracks during conversion by asking again; that choice is remembered too.
    await reporting.choose(principal, started.session.id, {
      AudioStreamIndex: audio !== null && audio.ordinal === audioIndex ? audioIndex : null,
      SubtitleStreamIndex: requestedSubtitle ?? null,
    });
    return {
      MediaSources: [
        {
          ...mediaSourceInfo(itemId, item.title, source, streams),
          SupportsDirectPlay: decision.kind === "DirectPlay",
          SupportsTranscoding: decision.kind === "Transcode",
          ...(decision.kind === "Transcode"
            ? {
                TranscodingUrl: `/Videos/${jellyfinId}/adaptive/${audioPosition}/master.m3u8?${auth}${
                  decision.ceilingKbps === null
                    ? ""
                    : `&MaxStreamingBitrate=${decision.ceilingKbps * 1000}`
                }`,
                TranscodingSubProtocol: "hls",
                TranscodingContainer: "ts",
              }
            : {}),
          ...(audio === null ? {} : { DefaultAudioStreamIndex: audio.ordinal }),
          DefaultSubtitleStreamIndex: subtitleIndex,
        },
      ],
      PlaySessionId: playSessionId,
    };
  };

  const stream = async (context: PlaybackContext, itemId: string) => {
    const file = await call(playback.authorizeTrack(context.principal, itemId, Date.now()));
    const release = media.admit(context.request, file.userId, sessionKey(context));
    try {
      return await media.serveFile({
        request: context.request,
        path: file.absolutePath,
        size: file.size,
        modifiedAtMs: file.modifiedAtMs,
        mimeType: file.mimeType,
      });
    } finally {
      release();
    }
  };

  const adaptive = async (
    context: PlaybackContext,
    itemId: string,
    audioIndex: string,
    path: string,
  ) => {
    const index = integer(audioIndex);
    if (index === null || index < 0 || index > 1024) throw badRequest("Invalid audio track");
    const file = await call(playback.authorizeTrack(context.principal, itemId, Date.now()));
    const key = sessionKey(context);
    const release = media.admit(context.request, file.userId, key);
    try {
      const playSessionId =
        fromJellyfinId(context.query("playSessionId")) ?? context.principal.sessionId;
      const cap = integer(context.query("maxStreamingBitrate"));
      return await media.adaptiveStreams.serve(
        context.request,
        { absolutePath: file.absolutePath, sessionId: key, userId: file.userId },
        { audioIndex: index, file: path },
        {
          childQuery: `${credentials(context, toJellyfinId(playSessionId))}${
            cap === null ? "" : `&MaxStreamingBitrate=${cap}`
          }`,
          ceilingKbps: cap === null ? null : Math.max(1, Math.floor(cap / 1000)),
        },
      );
    } finally {
      release();
    }
  };

  const formats: Record<string, SubtitleFormat> = {
    vtt: "vtt",
    webvtt: "vtt",
    srt: "srt",
    subrip: "srt",
    ass: "ass",
    ssa: "ass",
  };

  const subtitle = async (
    context: PlaybackContext,
    itemId: string,
    streamIndex: string,
    requestedFormat: string,
  ) => {
    const index = integer(streamIndex);
    const format = formats[requestedFormat.toLowerCase()];
    if (index === null || index < 0 || format === undefined)
      throw badRequest("Unsupported subtitle request");
    const file = await call(playback.authorizeTrack(context.principal, itemId, Date.now()));
    const source = await call(queries.source(itemId));
    const stream = source?.streams.find(
      (candidate) => candidate.kind === "subtitle" && candidate.ordinal === index,
    );
    if (stream === undefined || !isTextSubtitle(stream.codec)) throw notFound("Subtitle not found");
    if (format === "ass" && stream.codec !== "ass" && stream.codec !== "ssa")
      throw badRequest("Only ASS subtitles are delivered as ASS");
    const key = sessionKey(context);
    const release = media.admit(context.request, file.userId, key);
    try {
      const path = await subtitles.extract({
        input: file.absolutePath,
        cacheName: `${file.trackId}-${file.size.toString(16)}-${Math.trunc(file.modifiedAtMs).toString(16)}`,
        index,
        format,
        sessionId: key,
        userId: file.userId,
      });
      const details = await stat(path);
      return await media.serveFile({
        request: context.request,
        path,
        size: details.size,
        modifiedAtMs: Math.trunc(details.mtimeMs),
        mimeType: subtitleMimeTypes[format],
      });
    } finally {
      release();
    }
  };

  return { playbackInfo, stream, adaptive, subtitle };
};
