import { Schema } from "effect";
import { CatalogItem, PlayableMedia, PlayableStream } from "./models.ts";
import { UtcMillis, Uuid } from "./schemas/common.ts";
import { TrackMemory } from "./track-memory.ts";

/** Playback past this share of an item's duration counts as having watched it. */
export const WATCHED_FRACTION = 0.9;

export const isWatchCompleted = (positionMs: number, durationMs: number | null): boolean =>
  positionMs > 0 &&
  durationMs !== null &&
  durationMs > 0 &&
  positionMs / durationMs >= WATCHED_FRACTION;

/**
 * The identity of a file's exact bytes as the server last scanned them. Any change to the file
 * changes it, so bytes kept under one revision are never served as another.
 */
export const mediaRevision = (sizeBytes: number, modifiedAtMs: number): string =>
  `W/"${sizeBytes.toString(16)}-${Math.trunc(modifiedAtMs).toString(16)}"`;

/** Everything a client needs to fetch one file for later, issued by the server for one device. */
export const DownloadTicket = Schema.Struct({
  downloadId: Uuid,
  itemId: Uuid,
  sourceId: Uuid,
  title: Schema.String.check(Schema.isMinLength(1)),
  titleId: Schema.NullOr(Uuid),
  streamPath: Schema.String.check(Schema.isMinLength(1)),
  grantToken: Schema.String.check(Schema.isMinLength(1)),
  revision: Schema.String.check(Schema.isMinLength(1)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  mimeType: Schema.String.check(Schema.isMinLength(1)),
  durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  streams: Schema.Array(PlayableStream),
  media: PlayableMedia,
  trackMemory: Schema.optional(TrackMemory),
  expiresAtMs: UtcMillis,
});
export type DownloadTicket = Schema.Schema.Type<typeof DownloadTicket>;

export const DownloadSyncRequest = Schema.Struct({
  downloads: Schema.Array(Schema.Struct({ downloadId: Uuid, revision: Schema.String })).check(
    Schema.isMaxLength(10_000),
  ),
});
export type DownloadSyncRequest = Schema.Schema.Type<typeof DownloadSyncRequest>;

/**
 * What the server says of a download a device holds: still allowed and unchanged, allowed but
 * replaced by a newer file, or no longer allowed (or no longer there) at all.
 */
export const DownloadSyncResult = Schema.Struct({
  downloadId: Uuid,
  status: Schema.Literals(["valid", "changed", "revoked"]),
  revision: Schema.NullOr(Schema.String),
  expiresAtMs: Schema.NullOr(UtcMillis),
  /** Whether the viewer has watched the item, wherever they watched it. */
  completed: Schema.Boolean,
});
export type DownloadSyncResult = Schema.Schema.Type<typeof DownloadSyncResult>;

export const DownloadSyncResponse = Schema.Struct({ downloads: Schema.Array(DownloadSyncResult) });
export type DownloadSyncResponse = Schema.Schema.Type<typeof DownloadSyncResponse>;

// What the desktop keeps and shows. None of it reaches the server.

export const StreamingCacheSize = Schema.Literals(["none", "low", "medium", "high"]);
export type StreamingCacheSize = Schema.Schema.Type<typeof StreamingCacheSize>;

export const streamingCacheBytes: Readonly<Record<StreamingCacheSize, number>> = {
  none: 0,
  low: 512 * 1024 ** 2,
  medium: 1536 * 1024 ** 2,
  high: 5 * 1024 ** 3,
};

export const DeleteWatchedAfter = Schema.Literals(["immediately", "1d", "7d", "never"]);
export type DeleteWatchedAfter = Schema.Schema.Type<typeof DeleteWatchedAfter>;

export const RemoveUnopenedAfter = Schema.Literals(["30d", "60d", "90d", "never"]);
export type RemoveUnopenedAfter = Schema.Schema.Type<typeof RemoveUnopenedAfter>;

export const MIN_FREE_SPACE_PERCENT = 5;
export const MAX_FREE_SPACE_PERCENT = 75;

export const DownloadSettings = Schema.Struct({
  streamingCache: StreamingCacheSize,
  /** Downloads pause while the disk holding them has less than this share of its space free. */
  minimumFreeSpacePercent: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_FREE_SPACE_PERCENT, maximum: MAX_FREE_SPACE_PERCENT }),
  ),
  deleteWatchedAfter: DeleteWatchedAfter,
  removeUnopenedAfter: RemoveUnopenedAfter,
});
export type DownloadSettings = Schema.Schema.Type<typeof DownloadSettings>;

export const defaultDownloadSettings: DownloadSettings = {
  streamingCache: "none",
  minimumFreeSpacePercent: 10,
  deleteWatchedAfter: "1d",
  removeUnopenedAfter: "never",
};

export const DownloadSettingsPatch = Schema.Struct({
  streamingCache: Schema.optional(StreamingCacheSize),
  minimumFreeSpacePercent: Schema.optional(DownloadSettings.fields.minimumFreeSpacePercent),
  deleteWatchedAfter: Schema.optional(DeleteWatchedAfter),
  removeUnopenedAfter: Schema.optional(RemoveUnopenedAfter),
});
export type DownloadSettingsPatch = Schema.Schema.Type<typeof DownloadSettingsPatch>;

export const DownloadStatus = Schema.Literals([
  "queued",
  "downloading",
  "paused",
  /** Held back by something outside the download: no server, no space, or another account. */
  "waiting",
  "completed",
  "failed",
]);
export type DownloadStatus = Schema.Schema.Type<typeof DownloadStatus>;

export const DownloadEntry = Schema.Struct({
  id: Uuid,
  connectionId: Schema.String,
  itemId: Uuid,
  /** The item as it was when it was downloaded, so it can be shown and played offline. */
  item: CatalogItem,
  status: DownloadStatus,
  /** Why the download is waiting or failed. */
  reason: Schema.NullOr(Schema.String),
  downloadedBytes: Schema.Number,
  sizeBytes: Schema.Number,
  /** Exempt from automatic cleanup. */
  keep: Schema.Boolean,
  /** The show that downloaded it on its own, keeping its next episodes ready. */
  autoShowId: Schema.NullOr(Uuid),
  createdAtMs: UtcMillis,
  completedAtMs: Schema.NullOr(UtcMillis),
  watchedAtMs: Schema.NullOr(UtcMillis),
});
export type DownloadEntry = Schema.Schema.Type<typeof DownloadEntry>;

export const StorageUsage = Schema.Struct({
  downloadBytes: Schema.Number,
  cacheBytes: Schema.Number,
  freeBytes: Schema.Number,
  totalBytes: Schema.Number,
  /** Downloads pause when free space falls below this. */
  minimumFreeBytes: Schema.Number,
});
export type StorageUsage = Schema.Schema.Type<typeof StorageUsage>;

export const ShowDownloadRule = Schema.Struct({
  connectionId: Schema.String,
  showId: Uuid,
  title: Schema.String,
  /** How many unwatched episodes to keep ready. */
  episodes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
});
export type ShowDownloadRule = Schema.Schema.Type<typeof ShowDownloadRule>;

export const DownloadState = Schema.Struct({
  entries: Schema.Array(DownloadEntry),
  usage: StorageUsage,
  settings: DownloadSettings,
  shows: Schema.Array(ShowDownloadRule),
  /** Whether the active account's server can be reached and supports downloads. */
  available: Schema.Boolean,
});
export type DownloadState = Schema.Schema.Type<typeof DownloadState>;
