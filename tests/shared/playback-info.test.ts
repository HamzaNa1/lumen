import { describe, expect, test } from "bun:test";
import { describePlayback, measuredSize } from "../../packages/client/src/index.ts";
import type { PlayableStream, PlayerSession } from "../../packages/contracts/src/index.ts";

const stream = (id: string, overrides: Partial<PlayableStream> = {}): PlayableStream => ({
  id,
  kind: "audio",
  ordinal: 0,
  codec: null,
  language: null,
  title: null,
  isDefault: false,
  ...overrides,
});

const session = (streams: ReadonlyArray<PlayableStream>): PlayerSession => ({
  sessionId: "session",
  itemId: "item",
  sourceId: "source",
  title: "Film",
  streamUrl: "/api/v1/media/item",
  durationSeconds: 120,
  streams,
  grantExpiresInSeconds: 3600,
  grantToken: "grant",
});

const measured = {
  player: "Test player",
  playerSize: null,
  videoSize: null,
  droppedFrames: null,
  corruptedFrames: null,
};

describe("measuredSize", () => {
  test("is a whole-pixel size only once there is something to measure", () => {
    expect(measuredSize(1279.6, 720)).toEqual({ width: 1280, height: 720 });
    expect(measuredSize(0, 0)).toBeNull();
    expect(measuredSize(undefined, 720)).toBeNull();
  });
});

describe("describePlayback", () => {
  test("names how the file is reached, and the audio track being heard", () => {
    const streams = [stream("first"), stream("default", { isDefault: true }), stream("chosen")];
    const info = describePlayback(session(streams), "https://lumen.example", "chosen", measured);
    expect(info).toMatchObject({ player: "Test player", protocol: "https", durationSeconds: 120 });
    expect(info.audio?.id).toBe("chosen");
    // An older server does not describe the file.
    expect(info.media).toBeNull();
  });

  test("a player that has not chosen a track is heard playing the file's default, or its first", () => {
    const subtitle = stream("subtitle", { kind: "subtitle", isDefault: true });
    expect(
      describePlayback(
        session([subtitle, stream("first"), stream("default", { isDefault: true })]),
        "http://lumen.test",
        null,
        measured,
      ).audio?.id,
    ).toBe("default");
    expect(
      describePlayback(session([subtitle, stream("first")]), "http://lumen.test", null, measured)
        .audio?.id,
    ).toBe("first");
    expect(
      describePlayback(session([subtitle]), "http://lumen.test", null, measured).audio,
    ).toBeNull();
  });
});
