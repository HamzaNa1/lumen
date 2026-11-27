import { mediaRevision } from "@lumen/contracts";
import { ticksFromSeconds, toJellyfinId } from "./Ids";
import { isTextSubtitle, VIDEO_RANGE } from "./PlaybackDecision";
import type { VideoDetails } from "./Probe";
import type { ItemRow, SourceRow, StreamRow, View } from "./Queries";
import type {
  BaseItemDto,
  ItemType,
  MediaSourceInfo,
  MediaStream,
  SubtitleDelivery,
  UserData,
} from "./Schemas";

const types: Record<ItemRow["kind"], ItemType> = {
  movie: "Movie",
  show: "Series",
  season: "Season",
  episode: "Episode",
};

const iso = (ms: number) => new Date(ms).toISOString();

const parseList = (json: string): ReadonlyArray<string> => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

// Jellyfin names providers in title case: Tmdb, Imdb, Tvdb.
const providerIds = (json: string): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, id]) =>
        typeof id === "string" || typeof id === "number"
          ? [[`${key.charAt(0).toUpperCase()}${key.slice(1).toLowerCase()}`, String(id)]]
          : [],
      ),
    );
  } catch {
    return {};
  }
};

const premiereDate = (row: ItemRow): string | undefined => {
  if (row.releaseDate !== null) {
    const parsed = Date.parse(row.releaseDate);
    if (!Number.isNaN(parsed)) return iso(parsed);
  }
  return row.year === null ? undefined : iso(Date.UTC(row.year, 0, 1));
};

export const userData = (row: ItemRow): UserData => {
  const folder = row.kind === "show" || row.kind === "season";
  const played = row.played === 1;
  const position = played || folder ? 0 : row.positionSeconds;
  return {
    PlaybackPositionTicks: ticksFromSeconds(position),
    PlayCount: played ? 1 : 0,
    IsFavorite: row.isFavorite === 1,
    Played: played,
    Key: row.id,
    ItemId: toJellyfinId(row.id),
    ...(row.durationSeconds !== null && row.durationSeconds > 0 && position > 0
      ? { PlayedPercentage: Math.min(100, (position / row.durationSeconds) * 100) }
      : {}),
    ...(folder ? { UnplayedItemCount: row.unplayedCount ?? 0 } : {}),
    ...(row.playedAtMs === null ? {} : { LastPlayedDate: iso(row.playedAtMs) }),
  };
};

export interface ItemContext {
  readonly serverId: string;
  readonly canDownload: boolean;
}

export const baseItem = (
  row: ItemRow,
  context: ItemContext,
  mediaSources?: ReadonlyArray<MediaSourceInfo>,
): BaseItemDto => {
  const folder = row.kind === "show" || row.kind === "season";
  const id = toJellyfinId(row.id);
  const seriesId = row.kind === "show" ? null : row.seriesId;
  return {
    Name: row.title,
    Id: id,
    ServerId: context.serverId,
    Type: types[row.kind],
    MediaType: folder ? "Unknown" : "Video",
    IsFolder: folder,
    Etag: row.primaryTag ?? id,
    SortName: row.sortName,
    OriginalTitle: row.originalTitle,
    Overview: row.overview,
    ProductionYear: row.year,
    PremiereDate: premiereDate(row),
    DateCreated: iso(row.addedAtMs),
    OfficialRating: row.contentRating,
    CommunityRating: row.communityRating,
    Genres: parseList(row.genresJson),
    Tags: [],
    ProviderIds: providerIds(row.externalIdsJson),
    ParentId: toJellyfinId(row.parentId ?? row.libraryId),
    IndexNumber: row.indexNumber,
    IndexNumberEnd: row.indexNumberEnd,
    ParentIndexNumber: row.kind === "episode" ? row.seasonNumber : null,
    RunTimeTicks: row.durationSeconds === null ? null : ticksFromSeconds(row.durationSeconds),
    LocationType: "FileSystem",
    PlayAccess: "Full",
    CanDelete: false,
    CanDownload: context.canDownload && !folder,
    UserData: userData(row),
    ImageTags: row.primaryTag === null ? {} : { Primary: row.primaryTag },
    BackdropImageTags: row.backdropTag === null ? [] : [row.backdropTag],
    ...(folder
      ? {
          ChildCount: row.childCount ?? 0,
          RecursiveItemCount: row.episodeCount ?? 0,
        }
      : { VideoType: "VideoFile" }),
    ...(seriesId === null
      ? {}
      : {
          SeriesId: toJellyfinId(seriesId),
          SeriesName: row.seriesTitle,
          SeriesPrimaryImageTag: row.seriesPrimaryTag,
          ...(row.backdropTag === null && row.seriesBackdropTag !== null
            ? {
                ParentBackdropItemId: toJellyfinId(seriesId),
                ParentBackdropImageTags: [row.seriesBackdropTag],
              }
            : {}),
        }),
    ...(row.seasonId === null
      ? {}
      : { SeasonId: toJellyfinId(row.seasonId), SeasonName: row.seasonTitle }),
    ...(mediaSources === undefined
      ? {}
      : {
          MediaSources: mediaSources,
          MediaStreams: mediaSources[0]?.MediaStreams ?? [],
          Container: mediaSources[0]?.Container ?? null,
          HasSubtitles: (mediaSources[0]?.MediaStreams ?? []).some(
            (stream) => stream.Type === "Subtitle",
          ),
        }),
  };
};

export const viewItem = (view: View, serverId: string): BaseItemDto => ({
  Name: view.name,
  Id: toJellyfinId(view.id),
  ServerId: serverId,
  Type: "CollectionFolder",
  CollectionType: view.kind === "shows" ? "tvshows" : "movies",
  MediaType: "Unknown",
  IsFolder: true,
  Etag: toJellyfinId(view.id),
  SortName: view.name.toLowerCase(),
  ChildCount: view.childCount,
  LocationType: "FileSystem",
  PlayAccess: "Full",
  ImageTags: {},
  BackdropImageTags: [],
});

const language = (stream: StreamRow) => stream.language?.trim() || null;
const displayTitle = (stream: StreamRow): string => {
  const parts = [
    stream.title?.trim() || language(stream)?.toUpperCase() || "Unknown",
    stream.codec?.toUpperCase(),
    stream.kind === "audio" && stream.channels !== null ? `${stream.channels} ch` : null,
    stream.forced === 1 ? "Forced" : null,
  ];
  return parts.filter((part) => part !== null && part !== undefined).join(" - ");
};

export const mediaStream = (
  stream: StreamRow,
  delivery?: { readonly method: SubtitleDelivery; readonly url?: string },
  details?: VideoDetails | null,
): MediaStream => {
  const text = stream.kind === "subtitle" && isTextSubtitle(stream.codec);
  const video = stream.kind === "video";
  const probed = video ? (details ?? null) : null;
  const rangeType = probed?.rangeType ?? VIDEO_RANGE;
  return {
    Type: stream.kind === "video" ? "Video" : stream.kind === "audio" ? "Audio" : "Subtitle",
    Index: stream.ordinal,
    Codec: stream.codec,
    Language: language(stream),
    Title: stream.title,
    DisplayTitle: displayTitle(stream),
    IsDefault: stream.isDefault === 1,
    IsForced: stream.forced === 1,
    IsHearingImpaired: stream.hearingImpaired === 1,
    IsExternal: false,
    // Every stream Lumen lists is one the file carries, not one a conversion made.
    IsOriginal: true,
    IsInterlaced: probed?.interlaced ?? false,
    IsTextSubtitleStream: text,
    SupportsExternalStream: text,
    VideoRange: video
      ? rangeType === "SDR" || rangeType === "DOVIWithSDR"
        ? "SDR"
        : "HDR"
      : "Unknown",
    VideoRangeType: video ? rangeType : "Unknown",
    AudioSpatialFormat: "None",
    ...(probed === null
      ? {}
      : {
          ...(probed.profile === null ? {} : { Profile: probed.profile }),
          ...(probed.level === null ? {} : { Level: probed.level }),
          ...(probed.bitDepth === null ? {} : { BitDepth: probed.bitDepth }),
          ...(probed.anamorphic === null ? {} : { IsAnamorphic: probed.anamorphic }),
          ...(probed.refFrames === null ? {} : { RefFrames: probed.refFrames }),
          ...(probed.codecTag === null ? {} : { CodecTag: probed.codecTag }),
          ...(probed.frameRate === null ? {} : { AverageFrameRate: probed.frameRate }),
        }),
    ...(stream.width === null ? {} : { Width: stream.width }),
    ...(stream.height === null ? {} : { Height: stream.height }),
    ...(stream.bitrate === null ? {} : { BitRate: stream.bitrate }),
    ...(stream.channels === null ? {} : { Channels: stream.channels }),
    ...(stream.sampleRateHz === null ? {} : { SampleRate: stream.sampleRateHz }),
    ...(delivery === undefined
      ? {}
      : {
          DeliveryMethod: delivery.method,
          ...(delivery.url === undefined
            ? {}
            : { DeliveryUrl: delivery.url, IsExternalUrl: false }),
        }),
  };
};

/** Bits per second over the whole file, when its size and length are known. */
export const sourceBitrate = (source: SourceRow): number | null =>
  source.size === null || source.durationSeconds === null || source.durationSeconds <= 0
    ? null
    : Math.round((source.size * 8) / source.durationSeconds);

/** The file as Jellyfin describes it before a player has asked to play it. */
export const mediaSourceInfo = (
  itemId: string,
  name: string,
  source: SourceRow,
  streams: ReadonlyArray<MediaStream> = source.streams.map((stream) => mediaStream(stream)),
): MediaSourceInfo => ({
  Id: toJellyfinId(itemId),
  Name: name,
  Protocol: "File",
  Type: "Default",
  Container: source.container,
  Size: source.size,
  ETag: source.size === null ? null : mediaRevision(source.size, source.modifiedAtMs ?? 0),
  RunTimeTicks: source.durationSeconds === null ? null : ticksFromSeconds(source.durationSeconds),
  Bitrate: sourceBitrate(source),
  IsRemote: false,
  ReadAtNativeFramerate: false,
  IgnoreDts: false,
  IgnoreIndex: false,
  GenPtsInput: false,
  SupportsTranscoding: false,
  SupportsDirectStream: false,
  SupportsDirectPlay: true,
  IsInfiniteStream: false,
  UseMostCompatibleTranscodingProfile: false,
  RequiresOpening: false,
  RequiresClosing: false,
  RequiresLooping: false,
  SupportsProbing: false,
  HasSegments: false,
  VideoType: "VideoFile",
  MediaStreams: streams,
  MediaAttachments: [],
  Formats: [],
  RequiredHttpHeaders: {},
  TranscodingSubProtocol: "http",
});
