import { describe, expect, test } from "bun:test";
import { decideConditional, decideRange } from "../../apps/server/src/core/RangePolicy";

describe("RangePolicy", () => {
  test("returns a full representation without a range", () => {
    expect(decideRange(null, 10)).toEqual({ kind: "full", start: 0, end: 9, size: 10 });
  });

  test("supports bounded, open-ended, and suffix ranges", () => {
    expect(decideRange("bytes=2-5", 10)).toEqual({ kind: "partial", start: 2, end: 5, size: 10 });
    expect(decideRange("bytes=7-", 10)).toEqual({ kind: "partial", start: 7, end: 9, size: 10 });
    expect(decideRange("bytes=-3", 10)).toEqual({ kind: "partial", start: 7, end: 9, size: 10 });
  });

  test("parses overflow-scale headers without numeric overflow", () => {
    expect(decideRange("bytes=-999999999999999999999", 10)).toEqual({ kind: "partial", start: 0, end: 9, size: 10 });
    expect(decideRange("bytes=999999999999999999999-", 10)).toEqual({ kind: "unsatisfiable" });
  });

  test("clamps an end and caps an oversized suffix", () => {
    expect(decideRange("bytes=8-99", 10)).toEqual({ kind: "partial", start: 8, end: 9, size: 10 });
    expect(decideRange("bytes=-99", 10)).toEqual({ kind: "partial", start: 0, end: 9, size: 10 });
  });

  test("rejects unsatisfiable single ranges", () => {
    expect(decideRange("bytes=10-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(decideRange("bytes=5-1", 10)).toEqual({ kind: "ignored" });
    expect(decideRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    expect(decideRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  test("ignores multiple, malformed, and non-byte ranges", () => {
    expect(decideRange("bytes=0-1,3-4", 10).kind).toBe("ignored");
    expect(decideRange("bytes=abc", 10).kind).toBe("ignored");
    expect(decideRange("items=0-1", 10).kind).toBe("ignored");
  });

  test("evaluates validators before If-Modified-Since", () => {
    const base = {
      method: "GET",
      ifMatch: null,
      ifNoneMatch: null,
      ifModifiedSince: null,
      ifUnmodifiedSince: null,
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
      etag: '"abc"',
      nowMs: 0,
    };
    expect(decideConditional({ ...base, ifNoneMatch: '"abc"' })).toBe("not_modified");
    expect(decideConditional({ ...base, ifNoneMatch: '"other"', ifModifiedSince: "Thu, 02 Jan 2025 00:00:00 GMT" })).toBe("ok");
    expect(decideConditional({ ...base, ifMatch: '"other"' })).toBe("precondition_failed");
    expect(decideConditional({ ...base, ifUnmodifiedSince: "Tue, 31 Dec 2024 00:00:00 GMT" })).toBe("precondition_failed");
  });
});
