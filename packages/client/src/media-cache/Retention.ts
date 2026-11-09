import type { DownloadSettings } from "@lumen/contracts";

const day = 24 * 3_600_000;

export const watchedRetentionMs: Readonly<
  Record<DownloadSettings["deleteWatchedAfter"], number | null>
> = {
  immediately: 0,
  "1d": day,
  "7d": 7 * day,
  never: null,
};

const unopenedDelayMs: Readonly<Record<DownloadSettings["removeUnopenedAfter"], number | null>> = {
  "30d": 30 * day,
  "60d": 60 * day,
  "90d": 90 * day,
  never: null,
};

export interface RetainedDownload {
  readonly id: string;
  /** The viewer asked to keep it, whatever the rules say. */
  readonly keep: boolean;
  /** Playing now; never taken away mid-playback. */
  readonly inUse: boolean;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
  readonly watchedAtMs: number | null;
  readonly lastOpenedAtMs: number | null;
}

type RetentionSettings = Pick<DownloadSettings, "deleteWatchedAfter" | "removeUnopenedAfter">;

/** When the cleanup rules make a download due for deletion, or null when they never do. */
const dueAtMs = (download: RetainedDownload, settings: RetentionSettings): number | null => {
  if (download.keep) return null;
  const watchedDelay = watchedRetentionMs[settings.deleteWatchedAfter];
  const unopenedDelay = unopenedDelayMs[settings.removeUnopenedAfter];
  const touchedAtMs = Math.max(
    download.lastOpenedAtMs ?? 0,
    download.completedAtMs ?? download.createdAtMs,
  );
  const times = [
    watchedDelay === null || download.watchedAtMs === null
      ? null
      : download.watchedAtMs + watchedDelay,
    unopenedDelay === null ? null : touchedAtMs + unopenedDelay,
  ].filter((time): time is number => time !== null);
  return times.length === 0 ? null : Math.min(...times);
};

/** The downloads the viewer's cleanup rules say to delete now. Space is never a reason. */
export const expiredDownloads = (
  downloads: ReadonlyArray<RetainedDownload>,
  settings: RetentionSettings,
  nowMs: number,
): ReadonlyArray<string> =>
  downloads
    .filter((download) => {
      const due = dueAtMs(download, settings);
      return !download.inUse && due !== null && due <= nowMs;
    })
    .map((download) => download.id);

/**
 * When cleanup next has something to delete. One playing now is looked at again after
 * `inUseRecheckMs`, since it goes as soon as playback stops.
 */
export const nextRetentionAtMs = (
  downloads: ReadonlyArray<RetainedDownload>,
  settings: RetentionSettings,
  nowMs: number,
  inUseRecheckMs: number,
): number | null => {
  const times = downloads
    .map((download) => {
      const due = dueAtMs(download, settings);
      return due === null ? null : download.inUse ? Math.max(due, nowMs + inUseRecheckMs) : due;
    })
    .filter((time): time is number => time !== null);
  return times.length === 0 ? null : Math.min(...times);
};

export interface CachedSegment {
  readonly key: string;
  readonly bytes: number;
  readonly lastUsedAtMs: number;
  /** Being read or written right now. */
  readonly busy: boolean;
}

/** The least recently used cached segments to drop so the rest fit in `budgetBytes`. */
export const segmentsOverBudget = (
  segments: ReadonlyArray<CachedSegment>,
  budgetBytes: number,
): ReadonlyArray<string> => {
  let total = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const evicted: string[] = [];
  for (const segment of [...segments].sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)) {
    if (total <= budgetBytes) break;
    if (segment.busy) continue;
    evicted.push(segment.key);
    total -= segment.bytes;
  }
  return evicted;
};
