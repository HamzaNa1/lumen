import { expect, test } from "bun:test";
import { positionAt } from "../../packages/contracts/src/watch-groups/timeline";
import {
  initialPlayback,
  transition,
} from "../../apps/server/src/features/watch-groups/GroupState";
const id = () => crypto.randomUUID();
const media = {
  itemId: id(),
  trackId: id(),
  sourceId: id(),
  sourceGeneration: 7,
  durationMs: 60_000,
};

test("pause anchors the authoritative timeline and explicit seek survives later pause/resume", () => {
  const initial = initialPlayback(id(), id(), id(), 100);
  expect(positionAt(initial, 1_000)).toBe(0);
  const playing = transition(
    initial,
    { type: "start", media, positionMs: 5_000, playbackId: id() },
    1_000,
  );
  expect(positionAt(playing, 2_250)).toBe(6_250);
  const paused = transition(playing, { type: "set-paused", paused: true }, 2_500);
  expect(positionAt(paused, 50_000)).toBe(6_500);
  const sought = transition(paused, { type: "seek", positionMs: 6_600 }, 3_000);
  const resumed = transition(sought, { type: "set-paused", paused: false }, 4_000);
  expect(resumed.alignmentRevision).toBe(sought.revision);
  expect(positionAt(resumed, 5_000)).toBe(7_600);
  expect(positionAt(resumed, 100_000)).toBe(60_000);
  expect(transition(resumed, { type: "stop", playbackId: id() }, 6_000).media).toBeNull();
});

test("starts and stops invalidate work; stale end timers cannot end replacement playback", () => {
  const playing = transition(
    initialPlayback(id(), id(), id(), 0),
    { type: "start", media, positionMs: 0, playbackId: id() },
    100,
  );
  const replacement = transition(
    playing,
    { type: "start", media, positionMs: 0, playbackId: id() },
    200,
  );
  expect(replacement.playbackId).not.toBe(playing.playbackId);
  expect(
    transition(
      replacement,
      { type: "end", expectedRevision: playing.revision, expectedPlaybackId: playing.playbackId },
      100_000,
    ),
  ).toBe(replacement);
  const ended = transition(
    replacement,
    {
      type: "end",
      expectedRevision: replacement.revision,
      expectedPlaybackId: replacement.playbackId,
    },
    60_200,
  );
  expect(ended.mode).toBe("ended");
  expect(positionAt(ended, 200_000)).toBe(60_000);
  expect(() => transition(ended, { type: "set-paused", paused: false }, 70_000)).toThrow();
  expect(transition(ended, { type: "seek", positionMs: 50_000 }, 70_000).mode).toBe("paused");
  expect(() => transition(playing, { type: "seek", positionMs: 60_001 }, 1_000)).toThrow();
  expect(() => transition(playing, { type: "seek", positionMs: NaN }, 1_000)).toThrow();
  const stopped = transition(playing, { type: "stop", playbackId: id() }, 200);
  expect(stopped.playbackId).not.toBe(playing.playbackId);
  expect(() => transition(stopped, { type: "seek", positionMs: 0 }, 300)).toThrow();
});
