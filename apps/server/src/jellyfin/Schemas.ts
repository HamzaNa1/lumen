/**
 * Jellyfin's request and response shapes. They stay out of `packages/contracts` because no Lumen
 * product reads them, and keeping them here lets this module be deleted whole. Requests are
 * decoded leniently: Jellyfin apps send many fields Lumen ignores, and null for most of them.
 */
import { Schema } from "effect";
import type { VideoRangeType } from "./Probe";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

export const AuthenticateByName = Schema.Struct({
  Username: Text(200).check(Schema.isMinLength(1)),
  Pw: Optional(Text(1024)),
});

const ProfileCondition = Schema.Struct({
  Condition: Optional(Text(100)),
  Property: Optional(Text(100)),
  Value: Optional(Text(1000)),
  IsRequired: Optional(Schema.Boolean),
});
export type ProfileCondition = Schema.Schema.Type<typeof ProfileCondition>;

const List = <S extends Schema.Top>(schema: S) =>
  Optional(Schema.Array(schema).check(Schema.isMaxLength(500)));

export const DeviceProfile = Schema.Struct({
  MaxStreamingBitrate: Optional(Schema.Number),
  DirectPlayProfiles: List(
    Schema.Struct({
      Container: Optional(Text(1000)),
      VideoCodec: Optional(Text(1000)),
      AudioCodec: Optional(Text(1000)),
      Type: Optional(Text(100)),
    }),
  ),
  CodecProfiles: List(
    Schema.Struct({
      Type: Optional(Text(100)),
      Codec: Optional(Text(1000)),
      Container: Optional(Text(1000)),
      Conditions: List(ProfileCondition),
      ApplyConditions: List(ProfileCondition),
    }),
  ),
  SubtitleProfiles: List(
    Schema.Struct({
      Format: Optional(Text(100)),
      Method: Optional(Text(100)),
    }),
  ),
});
export type DeviceProfile = Schema.Schema.Type<typeof DeviceProfile>;

export const PlaybackInfoBody = Schema.Struct({
  MaxStreamingBitrate: Optional(Schema.Number),
  StartTimeTicks: Optional(Schema.Number),
  AudioStreamIndex: Optional(Schema.Number),
  SubtitleStreamIndex: Optional(Schema.Number),
  MediaSourceId: Optional(Text(100)),
  DeviceProfile: Optional(DeviceProfile),
  EnableDirectPlay: Optional(Schema.Boolean),
  EnableTranscoding: Optional(Schema.Boolean),
});

/** `PlaybackStartInfo`, `PlaybackProgressInfo` and `PlaybackStopInfo` share these fields. */
export const PlaybackReport = Schema.Struct({
  ItemId: Optional(Text(100)),
  PlaySessionId: Optional(Text(100)),
  PositionTicks: Optional(Schema.Number),
  IsPaused: Optional(Schema.Boolean),
  AudioStreamIndex: Optional(Schema.Number),
  SubtitleStreamIndex: Optional(Schema.Number),
  Failed: Optional(Schema.Boolean),
});
export type PlaybackReport = Schema.Schema.Type<typeof PlaybackReport>;

export interface UserData {
  readonly PlaybackPositionTicks: number;
  readonly PlayCount: number;
  readonly IsFavorite: boolean;
  readonly Played: boolean;
  readonly Key: string;
  readonly ItemId: string;
  readonly PlayedPercentage?: number;
  readonly UnplayedItemCount?: number;
  readonly LastPlayedDate?: string;
}

export interface MediaStream {
  readonly Type: "Video" | "Audio" | "Subtitle";
  readonly Index: number;
  readonly Codec: string | null;
  readonly Language: string | null;
  readonly Title: string | null;
  readonly DisplayTitle: string;
  readonly IsDefault: boolean;
  readonly IsForced: boolean;
  readonly IsHearingImpaired: boolean;
  readonly IsExternal: boolean;
  readonly IsOriginal: boolean;
  readonly IsInterlaced: boolean;
  readonly IsTextSubtitleStream: boolean;
  readonly SupportsExternalStream: boolean;
  readonly VideoRange: "Unknown" | "SDR" | "HDR";
  readonly VideoRangeType: "Unknown" | VideoRangeType;
  readonly Profile?: string;
  readonly Level?: number;
  readonly BitDepth?: number;
  readonly IsAnamorphic?: boolean;
  readonly RefFrames?: number;
  readonly CodecTag?: string;
  readonly AverageFrameRate?: number;
  readonly AudioSpatialFormat: "None";
  readonly Width?: number;
  readonly Height?: number;
  readonly BitRate?: number;
  readonly Channels?: number;
  readonly SampleRate?: number;
  readonly DeliveryMethod?: SubtitleDelivery;
  readonly DeliveryUrl?: string;
  readonly IsExternalUrl?: boolean;
}

export type SubtitleDelivery = "Embed" | "External" | "Drop";

export interface MediaSourceInfo {
  readonly Id: string;
  readonly Name: string;
  readonly Protocol: "File";
  readonly Type: "Default";
  readonly Container: string | null;
  readonly Size: number | null;
  readonly ETag: string | null;
  readonly RunTimeTicks: number | null;
  readonly Bitrate: number | null;
  readonly IsRemote: boolean;
  readonly ReadAtNativeFramerate: boolean;
  readonly IgnoreDts: boolean;
  readonly IgnoreIndex: boolean;
  readonly GenPtsInput: boolean;
  readonly SupportsTranscoding: boolean;
  readonly SupportsDirectStream: boolean;
  readonly SupportsDirectPlay: boolean;
  readonly IsInfiniteStream: boolean;
  readonly UseMostCompatibleTranscodingProfile: boolean;
  readonly RequiresOpening: boolean;
  readonly RequiresClosing: boolean;
  readonly RequiresLooping: boolean;
  readonly SupportsProbing: boolean;
  readonly HasSegments: boolean;
  readonly VideoType: "VideoFile";
  readonly MediaStreams: ReadonlyArray<MediaStream>;
  readonly MediaAttachments: ReadonlyArray<never>;
  readonly Formats: ReadonlyArray<never>;
  readonly RequiredHttpHeaders: Readonly<Record<string, string>>;
  readonly TranscodingSubProtocol: "http" | "hls";
  readonly TranscodingUrl?: string;
  readonly TranscodingContainer?: string;
  readonly DefaultAudioStreamIndex?: number;
  readonly DefaultSubtitleStreamIndex?: number;
}

export type ItemType = "Movie" | "Series" | "Season" | "Episode" | "CollectionFolder";

export interface BaseItemDto {
  readonly Id: string;
  readonly ServerId: string;
  readonly Name: string;
  readonly Type: ItemType;
  readonly MediaType: "Video" | "Unknown";
  readonly IsFolder: boolean;
  readonly [field: string]: unknown;
}

export interface QueryResult<T> {
  readonly Items: ReadonlyArray<T>;
  readonly TotalRecordCount: number;
  readonly StartIndex: number;
}
