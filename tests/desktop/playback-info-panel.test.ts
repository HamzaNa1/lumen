import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaybackInfo } from "../../packages/contracts/src/index.ts";
import { PlaybackInfoPanel, PlaybackInfoView } from "../../packages/ui/src/PlaybackInfoPanel.tsx";
import {
  type PlaybackInfoContent,
  pollPlaybackInfo,
} from "../../packages/ui/src/playbackInfoPolling.ts";

const info: PlaybackInfo = {
  player: "mpv 0.40.0",
  protocol: "https",
  playerSize: null,
  videoSize: { width: 1920, height: 1080 },
  droppedFrames: 0,
  corruptedFrames: null,
  durationSeconds: 60,
  media: null,
  audio: null,
};

const render = (content: PlaybackInfoContent): string =>
  renderToStaticMarkup(PlaybackInfoView({ content, onClose: () => undefined }));

describe("PlaybackInfoView", () => {
  test("lists each section's rows under its heading", () => {
    const html = render({ kind: "ready", info });
    expect(html).toContain('aria-label="Playback info"');
    expect(html).toContain("<h2>Playback info</h2>");
    expect(html).toContain("<dt>Player</dt><dd>mpv 0.40.0</dd>");
    expect(html).toContain("<dt>Video resolution</dt><dd>1920×1080</dd>");
    expect(html).not.toContain("Original media info");
  });

  test("says why there is nothing to list", () => {
    expect(render({ kind: "loading" })).toContain("Loading…");
    expect(render({ kind: "idle" })).toContain("Nothing is playing.");
    expect(render({ kind: "failed" })).toContain("The player could not report on playback.");
  });
});

describe("PlaybackInfoPanel", () => {
  test("shows that it is loading until the player first answers", () => {
    const html = renderToStaticMarkup(
      createElement(PlaybackInfoPanel, { load: async () => info, onClose: () => undefined }),
    );
    expect(html).toContain("Loading…");
  });
});

describe("pollPlaybackInfo", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("asks again only once the last answer is in, and tells why when there is none", async () => {
    const contents: PlaybackInfoContent["kind"][] = [];
    const answer = Promise.withResolvers<PlaybackInfo>();
    let requests = 0;
    let load: (() => Promise<PlaybackInfo>) | undefined = () => {
      requests += 1;
      return answer.promise;
    };
    const stop = pollPlaybackInfo(
      () => load,
      (content) => contents.push(content.kind),
      5,
    );
    try {
      jest.advanceTimersByTime(100);
      expect(requests).toBe(1);
      expect(contents).toEqual([]);
      answer.resolve(info);
      await setImmediate();
      expect(contents).toEqual(["ready"]);
      jest.advanceTimersByTime(5);
      await setImmediate();
      expect(requests).toBe(2);
      expect(contents).toEqual(["ready", "ready"]);
      load = undefined;
      jest.advanceTimersByTime(5);
      expect(contents.at(-1)).toBe("idle");
      load = () => Promise.reject(new Error("unavailable"));
      jest.advanceTimersByTime(5);
      await setImmediate();
      expect(contents.at(-1)).toBe("failed");
    } finally {
      stop();
    }
    const told = contents.length;
    jest.advanceTimersByTime(100);
    await setImmediate();
    expect(contents).toHaveLength(told);
  });

  test("an answer that arrives after stopping is not passed on", async () => {
    const contents: PlaybackInfoContent[] = [];
    const answer = Promise.withResolvers<PlaybackInfo>();
    const stop = pollPlaybackInfo(
      () => () => answer.promise,
      (content) => contents.push(content),
      5,
    );
    stop();
    answer.resolve(info);
    await setImmediate();
    jest.advanceTimersByTime(100);
    expect(contents).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
