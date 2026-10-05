import { expect, test } from "bun:test";
import { predictWatchAction, type WatchViewer } from "../../packages/client/src/index.ts";
import type { WatchAction, WatchGroup } from "../../packages/contracts/src/index.ts";

const viewer: WatchViewer = { memberId: "me", displayName: "Me", readiness: true };
const group = (patch: Partial<WatchGroup> = {}): WatchGroup => ({
  id: "group",
  name: "Movie night",
  hasPassword: false,
  members: [{ id: "owner", displayName: "Owner" }],
  playback: { itemId: "item", title: "Film", positionSeconds: 10, paused: false, updatedAtMs: 1 },
  revision: 4,
  ...patch,
});
const predict = (action: WatchAction, current: WatchGroup | null, as: WatchViewer = viewer) =>
  predictWatchAction(action, { group: current }, as, 1000);

test("pausing and stopping show the group's next revision at once", () => {
  const current = group();
  const paused = predict(
    { type: "pause", itemId: "item", paused: true, positionSeconds: 12 },
    current,
  );
  expect(paused?.apply(current)).toMatchObject({
    revision: 5,
    playback: { title: "Film", positionSeconds: 12, paused: true, updatedAtMs: 1000 },
  });
  expect(predict({ type: "stop", itemId: "item" }, current)?.apply(current)).toMatchObject({
    revision: 5,
    playback: null,
  });
});

test("a group about to play holds for a viewer whose player reports back, and plays otherwise", () => {
  const current = group();
  const seek: WatchAction = { type: "seek", itemId: "item", positionSeconds: 40 };
  expect(predict(seek, current)?.apply(current)?.playback).toEqual({
    itemId: "item",
    title: "Film",
    positionSeconds: 40,
    paused: true,
    updatedAtMs: 1000,
    waitingFor: [],
  });
  const plain = predict(seek, current, { ...viewer, readiness: false });
  expect(plain?.apply(current)?.playback).toMatchObject({ positionSeconds: 40, paused: false });
});

test("seeking a paused group leaves it paused, and resuming a held group changes nothing", () => {
  const paused = group({
    playback: { itemId: "item", title: "Film", positionSeconds: 10, paused: true, updatedAtMs: 1 },
  });
  expect(
    predict({ type: "seek", itemId: "item", positionSeconds: 3 }, paused)?.apply(paused)?.playback,
  ).toMatchObject({ positionSeconds: 3, paused: true });
  const held = group({
    playback: {
      itemId: "item",
      title: "Film",
      positionSeconds: 10,
      paused: true,
      updatedAtMs: 1,
      waitingFor: ["owner"],
    },
  });
  expect(
    predict({ type: "pause", itemId: "item", paused: false, positionSeconds: 10 }, held),
  ).toBeNull();
});

test("a playback prediction stands only until the group moves past the revision it was made at", () => {
  const current = group();
  const prediction = predict({ type: "stop", itemId: "item" }, current);
  expect(prediction?.awaits(current)).toBe(true);
  expect(prediction?.awaits({ ...current, members: [] })).toBe(true);
  expect(prediction?.awaits({ ...current, revision: 5 })).toBe(false);
  expect(prediction?.awaits(null)).toBe(false);
});

test("what only the server knows is not predicted", () => {
  const current = group();
  expect(predict({ type: "stop", itemId: "other" }, current)).toBeNull();
  expect(predict({ type: "stop", itemId: "item" }, null)).toBeNull();
  expect(predict({ type: "join", groupId: "group", password: "guess" }, null)).toBeNull();
  expect(predict({ type: "join", groupId: "gone", password: "" }, null)).toBeNull();
  const unnamed = { ...viewer, displayName: null };
  expect(predict({ type: "join", groupId: "group", password: "" }, null, unnamed)).toBeNull();
  expect(predict({ type: "create", name: "New", password: "" }, null, unnamed)).toBeNull();
  expect(predict({ type: "leave" }, null)).toBeNull();
});

test("creating and leaving show the viewer's membership at once", () => {
  const listed = group();
  const created = predict({ type: "create", name: " Late show ", password: "secret" }, listed);
  expect(created?.apply(listed)).toMatchObject({
    name: "Late show",
    hasPassword: true,
    members: [{ id: "me", displayName: "Me" }],
    playback: null,
    revision: 0,
  });
  expect(created?.awaits(listed)).toBe(true);
  expect(created?.awaits(null)).toBe(true);
  expect(created?.awaits(group({ id: "new" }))).toBe(false);

  const left = predict({ type: "leave" }, listed);
  expect(left?.apply(listed)).toBeNull();
  expect(left?.awaits(listed)).toBe(true);
  expect(left?.awaits(null)).toBe(false);
});

for (const current of [group({ playback: null, revision: 0 }), group()]) {
  test(`playing a new item is immediate with ${current.playback === null ? "no" : "existing"} group playback`, () => {
    const prediction = predict(
      { type: "play", itemId: "new", title: "Next film", positionSeconds: 25 },
      current,
    );
    expect(prediction?.apply(current)).toMatchObject({
      revision: current.revision + 1,
      playback: {
        itemId: "new",
        title: "Next film",
        positionSeconds: 25,
        paused: true,
        waitingFor: [],
        updatedAtMs: 1000,
      },
    });
    expect(prediction?.awaits({ ...current, revision: current.revision + 1 })).toBe(false);
  });
}

test("a play without a title still predicts loading, and reuses a known title", () => {
  expect(
    predict({ type: "play", itemId: "new", positionSeconds: 0 }, group())?.apply(group())?.playback
      ?.title,
  ).toBe("Loading…");
  expect(
    predict({ type: "play", itemId: "item", positionSeconds: 0 }, group())?.apply(group())?.playback
      ?.title,
  ).toBe("Film");
});

for (const hasPassword of [false, true]) {
  test(`joining a ${hasPassword ? "protected" : "passwordless"} group waits for the server`, () => {
    const listed = group({ hasPassword });
    const status = { group: null, groups: [listed] };
    expect(
      predictWatchAction(
        { type: "join", groupId: listed.id, password: "secret" },
        status,
        viewer,
        1000,
      ),
    ).toBeNull();
  });
}
