import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaybackInfo } from "../../packages/contracts/src/index.ts";
import { PlaybackInfoPanel, PlaybackInfoView } from "../../packages/ui/src/PlaybackInfoPanel.tsx";
import {
  type PlaybackInfoContent,
  pollPlaybackInfo,
} from "../../packages/ui/src/playbackInfoPolling.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  test("asks again only once the last answer is in, and tells why when there is none", async () => {
    const contents: PlaybackInfoContent["kind"][] = [];
    let load: (() => Promise<PlaybackInfo>) | undefined;
    let pending = 0;
    let overlapped = false;
    load = async () => {
      pending += 1;
      overlapped ||= pending > 1;
      await wait(15);
      pending -= 1;
      return info;
    };
    const stop = pollPlaybackInfo(
      () => load,
      (content) => contents.push(content.kind),
      5,
    );
    await wait(60);
    expect(contents.length).toBeGreaterThanOrEqual(2);
    expect(new Set(contents)).toEqual(new Set(["ready"]));
    expect(overlapped).toBe(false);

    load = undefined;
    await wait(40);
    expect(contents.at(-1)).toBe("idle");
    load = () => Promise.reject(new Error("unavailable"));
    await wait(30);
    expect(contents.at(-1)).toBe("failed");

    stop();
    const told = contents.length;
    await wait(30);
    expect(contents).toHaveLength(told);
  });

  test("an answer that arrives after stopping is not passed on", async () => {
    const contents: PlaybackInfoContent[] = [];
    const stop = pollPlaybackInfo(
      () => async () => {
        await wait(10);
        return info;
      },
      (content) => contents.push(content),
      5,
    );
    stop();
    await wait(30);
    expect(contents).toEqual([]);
  });
});
