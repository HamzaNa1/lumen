import type { BufferedRange } from "@lumen/contracts";

/** Provisional read-ahead profile, shared by subprocess mpv and libmpv. Bytes also bound time. */
export const mpvCacheArguments = [
  "--cache=yes",
  "--cache-secs=60",
  "--demuxer-max-bytes=256MiB",
  "--demuxer-max-back-bytes=32MiB",
  "--cache-pause=yes",
  "--cache-pause-wait=2",
  "--cache-pause-initial=no",
] as const;

const bufferedRange = (start: unknown, end: unknown): BufferedRange | null => {
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    end <= Math.max(0, start)
  )
    return null;
  return { startSeconds: Math.max(0, start), endSeconds: end };
};

/** A missing sample is unknown, not an empty cache. */
export const mpvBufferedRanges = (value: unknown): ReadonlyArray<BufferedRange> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const ranges: BufferedRange[] = [];
  if ("seekable-ranges" in value && Array.isArray(value["seekable-ranges"])) {
    for (const candidate of value["seekable-ranges"]) {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        !("start" in candidate) ||
        !("end" in candidate)
      )
        continue;
      const range = bufferedRange(candidate.start, candidate.end);
      if (range !== null) ranges.push(range);
    }
  }
  // Read-ahead can be playable before there are enough keyframes for cached seeking.
  if ("reader-pts" in value && "cache-end" in value) {
    const range = bufferedRange(value["reader-pts"], value["cache-end"]);
    if (range !== null) ranges.push(range);
  }
  ranges.sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: BufferedRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.startSeconds <= previous.endSeconds) {
      merged[merged.length - 1] = {
        startSeconds: previous.startSeconds,
        endSeconds: Math.max(previous.endSeconds, range.endSeconds),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
};

/** How far MPV's demuxer has read beyond what is playing; infinite once it has read to the end. */
export const mpvBufferedAhead = (value: unknown): number => {
  if (value === null || typeof value !== "object") return 0;
  if ("eof" in value && value.eof === true) return Number.POSITIVE_INFINITY;
  const duration = "cache-duration" in value ? value["cache-duration"] : null;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 0;
};
