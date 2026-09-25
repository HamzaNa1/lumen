import { describe, expect, test } from "bun:test";
import type { IpcPlayableStream } from "../../packages/contracts/src/index.ts";
import { streamLabels } from "../../packages/ui/src/PlayerFormatting.ts";

const stream = (overrides: Partial<IpcPlayableStream>): IpcPlayableStream => ({
  id: "00000000-0000-4000-8000-000000000000",
  kind: "audio",
  ordinal: 0,
  codec: null,
  language: null,
  title: null,
  isDefault: false,
  ...overrides,
});

describe("streamLabels", () => {
  test("names the language, title, and audio codec", () => {
    expect(
      streamLabels([
        stream({ language: "eng", title: "Stereo", codec: "opus" }),
        stream({ language: "fra", title: "Commentary", codec: "eac3" }),
      ]),
    ).toEqual(["English · Stereo · Opus", "French · Commentary · Dolby Digital Plus"]);
  });

  test("leaves the codec off subtitles", () => {
    expect(
      streamLabels([
        stream({ kind: "subtitle", language: "eng", codec: "subrip" }),
        stream({ kind: "subtitle", language: "spa", codec: "subrip" }),
      ]),
    ).toEqual(["English", "Spanish"]);
  });

  test("numbers tracks that would otherwise share a label", () => {
    expect(
      streamLabels([
        stream({ kind: "subtitle", language: "eng" }),
        stream({ kind: "subtitle", language: "eng", title: "SDH" }),
        stream({ kind: "subtitle", language: "eng" }),
      ]),
    ).toEqual(["English · Track 1", "English · SDH", "English · Track 3"]);
  });

  test("falls back to the track number and raw codes", () => {
    expect(
      streamLabels([
        stream({ language: "und", codec: "pcm_s16le" }),
        stream({}),
        stream({ language: "qaa", title: "English" }),
      ]),
    ).toEqual(["PCM", "Track 2", "QAA · English"]);
  });
});
