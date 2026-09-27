import { expect, test } from "bun:test";
import { chooseCorrection } from "../../apps/desktop/src/main/watch-groups/SyncPolicy";

test("the one-second boundary selects hard alignment in either direction", () => {
  const decide = (driftMs: number) =>
    chooseCorrection({
      targetMs: 20_000,
      actualMs: 20_000 - driftMs,
      playing: true,
      adjustingRate: false,
      forceAlignment: false,
    });
  expect(decide(999)).toEqual({ type: "rate", rate: 1.05 });
  expect(decide(1_000)).toEqual({ type: "seek", positionMs: 20_000 });
  expect(decide(1_001)).toEqual({ type: "seek", positionMs: 20_000 });
  expect(decide(-999)).toEqual({ type: "rate", rate: 0.95 });
  expect(decide(-1_000)).toEqual({ type: "seek", positionMs: 20_000 });
  expect(decide(-1_001)).toEqual({ type: "seek", positionMs: 20_000 });
});

test("hysteresis settles at exactly one and explicit paused subsecond seeks are never swallowed", () => {
  const input = {
    targetMs: 10_000,
    actualMs: 9_900,
    playing: true,
    adjustingRate: false,
    forceAlignment: false,
  };
  expect(chooseCorrection(input)).toEqual({ type: "rate", rate: 1 });
  expect(chooseCorrection({ ...input, adjustingRate: true })).toEqual({ type: "rate", rate: 1.01 });
  expect(chooseCorrection({ ...input, adjustingRate: true, actualMs: 9_920 })).toEqual({
    type: "rate",
    rate: 1,
  });
  expect(chooseCorrection({ ...input, forceAlignment: true, playing: false })).toEqual({
    type: "seek",
    positionMs: 10_000,
  });
  expect(chooseCorrection({ ...input, forceAlignment: true, actualMs: 9_990 })).toEqual({
    type: "seek",
    positionMs: 10_000,
  });
  expect(chooseCorrection({ ...input, actualMs: 10_080, playing: false })).toEqual({
    type: "rate",
    rate: 1,
  });
});
