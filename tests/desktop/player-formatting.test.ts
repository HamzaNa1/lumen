import { describe, expect, test } from "bun:test";
import type { PlayableStream } from "../../packages/contracts/src/index.ts";
import { formatEndsAt, streamLabels } from "../../packages/ui/src/PlayerFormatting.ts";

const stream = (overrides: Partial<PlayableStream>): PlayableStream => ({
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

describe("formatEndsAt", () => {
  const clockTime = (date: Date): string =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);

  test("adds what is left to play to the current time", () => {
    expect(formatEndsAt(90 * 60, new Date(2026, 0, 1, 8, 26).getTime())).toBe(
      `Ends at ${clockTime(new Date(2026, 0, 1, 9, 56))}`,
    );
  });

  test("carries past midnight", () => {
    expect(formatEndsAt(45 * 60, new Date(2026, 0, 1, 23, 30).getTime())).toBe(
      `Ends at ${clockTime(new Date(2026, 0, 2, 0, 15))}`,
    );
  });

  test("never ends in the past", () => {
    const now = new Date(2026, 0, 1, 8, 26).getTime();
    expect(formatEndsAt(-30, now)).toBe(`Ends at ${clockTime(new Date(now))}`);
  });
});
