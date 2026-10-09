import { describe, expect, test } from "bun:test";
import { mpvBufferedRanges } from "../../apps/desktop/src/main/player/MpvCache";

describe("MPV buffered timeline ranges", () => {
  test("shows read-ahead when the cache has no seekable keyframe range", () => {
    // MPV with a 60-second cache and a file whose keyframes are 120 seconds apart.
    expect(
      mpvBufferedRanges({
        "reader-pts": 1.125,
        "cache-end": 61.125,
        "cache-duration": 60,
        "seekable-ranges": [],
      }),
    ).toEqual([{ startSeconds: 1.125, endSeconds: 61.125 }]);
  });

  test("combines read-ahead with unordered overlapping seek ranges while preserving gaps", () => {
    expect(
      mpvBufferedRanges({
        "reader-pts": 30,
        "cache-end": 60,
        "seekable-ranges": [
          { start: 80, end: 90 },
          { start: 20, end: 40 },
          { start: 0, end: 25 },
          { start: 10, end: 15 },
        ],
      }),
    ).toEqual([
      { startSeconds: 0, endSeconds: 60 },
      { startSeconds: 80, endSeconds: 90 },
    ]);
  });

  test("clips a negative starting timestamp without losing the rest of the buffer", () => {
    expect(mpvBufferedRanges({ "seekable-ranges": [{ start: -0.08, end: 30 }] })).toEqual([
      { startSeconds: 0, endSeconds: 30 },
    ]);
    expect(mpvBufferedRanges({ "reader-pts": -0.08, "cache-end": 30 })).toEqual([
      { startSeconds: 0, endSeconds: 30 },
    ]);
  });

  test("distinguishes unavailable samples from a cache that has actually emptied", () => {
    for (const value of [null, undefined, false, 0, [], "unavailable"])
      expect(mpvBufferedRanges(value)).toBeNull();
    expect(mpvBufferedRanges({ "seekable-ranges": [] })).toEqual([]);
    expect(mpvBufferedRanges({ "reader-pts": 20, "cache-end": 20 })).toEqual([]);
    // Duration or EOF alone cannot locate buffered data on the timeline.
    expect(mpvBufferedRanges({ "cache-duration": 60, eof: true })).toEqual([]);
  });

  test("ignores invalid ranges without hiding valid ones or inventing endpoints", () => {
    expect(
      mpvBufferedRanges({
        "seekable-ranges": [
          null,
          {},
          { start: "0", end: 30 },
          { start: 0, end: Number.POSITIVE_INFINITY },
          { start: Number.NaN, end: 30 },
          { start: 30, end: 20 },
          { start: -10, end: -2 },
          { start: 10, end: 10 },
          { start: 10, end: 30 },
        ],
        "reader-pts": 30,
      }),
    ).toEqual([{ startSeconds: 10, endSeconds: 30 }]);
    expect(mpvBufferedRanges({ "seekable-ranges": null, "cache-end": 60 })).toEqual([]);
  });
});
