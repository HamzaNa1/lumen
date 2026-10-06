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
