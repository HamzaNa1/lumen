import { describe, expect, test } from "bun:test";
import type { PlayableStream, PlaybackInfo } from "../../packages/contracts/src/index.ts";
import {
  formatEndsAt,
  formatPlayerTime,
  playbackInfoSections,
  streamLabels,
  trackSelectionWarning,
} from "../../packages/ui/src/PlayerFormatting.ts";

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

  test("names distinguishing roles and channels even when titles are missing", () => {
    expect(
      streamLabels([
        stream({ language: "eng", commentary: true, channels: 6, codec: "aac" }),
        stream({ kind: "subtitle", language: "eng", forced: true }),
        stream({ kind: "subtitle", language: "eng", hearingImpaired: true }),
      ]),
    ).toEqual([
      "English · Commentary · AAC · 6 channels",
      "English · Forced",
      "English · Hearing impaired",
    ]);
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

describe("trackSelectionWarning", () => {
  test("says nothing when every track can be switched", () => {
    expect(trackSelectionWarning(true, true)).toBeNull();
  });

  test("warns about subtitles alone when only they cannot be selected", () => {
    expect(trackSelectionWarning(true, false)).toBe(
      "This browser can’t select embedded subtitles.",
    );
  });

  test("puts both limitations in one sentence when no track can be switched", () => {
    const both = "This browser can’t switch audio tracks or select embedded subtitles.";
    expect(trackSelectionWarning(false, true)).toBe(both);
    expect(trackSelectionWarning(false, false)).toBe(both);
  });
});

describe("playbackInfoSections", () => {
  const info: PlaybackInfo = {
    player: "mpv 0.40.0",
    protocol: "https",
    playerSize: { width: 1280, height: 720 },
    videoSize: { width: 1920, height: 1080 },
    droppedFrames: 3,
    corruptedFrames: null,
    durationSeconds: 1_000,
    media: {
      container: "mkv",
      sizeBytes: 1_500_000_000,
      video: { codec: "hevc", size: { width: 1920, height: 1080 }, bitrate: 10_500_000 },
    },
    audio: stream({ codec: "eac3", channels: 6, bitrate: 640_000, sampleRateHz: 48_000 }),
  };

  test("groups what the player and the server know the way Jellyfin shows it", () => {
    expect(playbackInfoSections(info)).toEqual([
      {
        title: "Playback info",
        rows: [
          ["Player", "mpv 0.40.0"],
          ["Play method", "Direct playing"],
          ["Protocol", "https"],
          ["Stream type", "Video"],
        ],
      },
      {
        title: "Video info",
        rows: [
          ["Player dimensions", "1280×720"],
          ["Video resolution", "1920×1080"],
          ["Dropped frames", "3"],
        ],
      },
      {
        title: "Original media info",
        rows: [
          ["Container", "mkv"],
          ["Size", "1.50 GB"],
          ["Bitrate", "12.0 Mbps"],
          ["Video codec", "HEVC"],
          ["Video resolution", "1920×1080"],
          ["Video bitrate", "10.5 Mbps"],
          ["Audio codec", "Dolby Digital Plus"],
          ["Audio bitrate", "640 kbps"],
          ["Audio channels", "6 channels"],
          ["Audio sample rate", "48000 Hz"],
        ],
      },
    ]);
  });

  test("leaves out what an older server or a player that has decoded nothing cannot say", () => {
    expect(
      playbackInfoSections({
        ...info,
        playerSize: null,
        videoSize: null,
        droppedFrames: null,
        media: null,
        audio: null,
      }).map((section) => section.title),
    ).toEqual(["Playback info"]);
  });
});

describe("formatPlayerTime", () => {
  test("shows minutes and seconds, adding hours only once there are any", () => {
    expect(formatPlayerTime(-3)).toBe("0:00");
    expect(formatPlayerTime(65.9)).toBe("1:05");
    expect(formatPlayerTime(3_725)).toBe("1:02:05");
  });
});
