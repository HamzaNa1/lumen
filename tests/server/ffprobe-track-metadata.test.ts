import { expect, test } from "bun:test";
import { parseFfprobeOutput } from "../../apps/server/src/media/Ffprobe";

test("probe descriptors retain language, channels, commentary and subtitle role dispositions", () => {
  const result = parseFfprobeOutput({
    streams: [
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        channels: 6,
        tags: { language: "eng", title: "Commentary" },
        disposition: { comment: 1, default: 1 },
      },
      {
        index: 2,
        codec_type: "subtitle",
        codec_name: "ass",
        tags: { language: "en" },
        disposition: { forced: 1, hearing_impaired: 1 },
      },
      { index: 3, codec_type: "audio" },
    ],
  });
  expect(result.streams[0]).toMatchObject({
    ordinal: 1,
    language: "eng",
    title: "Commentary",
    channels: 6,
    commentary: true,
    forced: false,
    hearingImpaired: false,
  });
  expect(result.streams[1]).toMatchObject({
    forced: true,
    hearingImpaired: true,
    commentary: false,
  });
  expect(result.streams[2]).toMatchObject({
    language: null,
    commentary: null,
    forced: null,
    hearingImpaired: null,
  });
});

test("format duration accepts fractional seconds", () => {
  const parse = (duration: string | undefined) =>
    parseFfprobeOutput({ format: { duration }, streams: [] }).durationMs;
  expect(parse("20.021000")).toBe(20_021);
  expect(parse("7200")).toBe(7_200_000);
  expect(parse("0.0004")).toBe(0);
  expect(parse(undefined)).toBeNull();
  expect(parse("N/A")).toBeNull();
  expect(parse("")).toBeNull();
  expect(parse("-1.5")).toBeNull();
});
