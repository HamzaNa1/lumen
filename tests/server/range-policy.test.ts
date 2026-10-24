import { expect, test } from "bun:test";
import { decideByteRange } from "../../apps/server/src/features/playback/RangePolicy";

test.each([
  [null, 10, { _tag: "Full" }],
  ["bytes=-", 10, { _tag: "Full" }],
  ["bytes=abc-2", 10, { _tag: "Full" }],
  ["bytes=3-1", 10, { _tag: "Full" }],
  ["bytes=0-1,4-5", 10, { _tag: "Full" }],
  ["bytes=2-4", 10, { _tag: "Partial", start: 2, endInclusive: 4 }],
  ["bytes=2-", 10, { _tag: "Partial", start: 2, endInclusive: 9 }],
  ["bytes=0-999999999999999999999", 10, { _tag: "Partial", start: 0, endInclusive: 9 }],
  ["bytes=-3", 10, { _tag: "Partial", start: 7, endInclusive: 9 }],
  ["bytes=-999999999999999999999", 10, { _tag: "Partial", start: 0, endInclusive: 9 }],
  ["bytes=-0", 10, { _tag: "Unsatisfiable" }],
  ["bytes=10-", 10, { _tag: "Unsatisfiable" }],
  ["bytes=0-", 0, { _tag: "Unsatisfiable" }],
  ["bytes=-1", 0, { _tag: "Unsatisfiable" }],
] as const)("decodes range %s for %s bytes", (header, size, expected) => {
  expect(decideByteRange(header, size)).toEqual(expected);
});

test("rejects invalid sizes and ignores oversized headers", () => {
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    expect(() => decideByteRange(null, size)).toThrow(RangeError);
  expect(decideByteRange(`bytes=0-${"9".repeat(1024)}`, 10)).toEqual({ _tag: "Full" });
});
