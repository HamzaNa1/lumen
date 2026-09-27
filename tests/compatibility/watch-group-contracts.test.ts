import { expect, test } from "bun:test";
import { Schema } from "../../packages/contracts/node_modules/effect/dist/index.js";
import {
  CreateWatchGroup,
  GroupClientFrame,
  GroupPlayback,
  GroupSnapshot,
  GroupServerFrame,
  IpcJoinWatchGroup,
  IpcPlayerState,
  IpcWatchGroupState,
  PlaybackSeconds,
} from "../../packages/contracts/src";
import { watchGroupSnapshot } from "../helpers/watch-groups";
test("watch group HTTP, socket and IPC contracts round-trip without credentials", () => {
  const snapshot = watchGroupSnapshot();
  const frame = { protocolVersion: 1, type: "snapshot", snapshot };
  expect(Schema.decodeUnknownSync(GroupServerFrame)(JSON.parse(JSON.stringify(frame)))).toEqual(
    frame,
  );
  expect(Schema.decodeUnknownSync(GroupSnapshot)(snapshot)).toEqual(snapshot);
  expect(
    Schema.decodeUnknownSync(IpcWatchGroupState)({
      connectionId: crypto.randomUUID(),
      snapshot,
      status: "ready",
      error: null,
    }).snapshot,
  ).toEqual(snapshot);
  expect(Schema.decodeUnknownSync(IpcJoinWatchGroup)({ groupId: snapshot.groupId })).toEqual({
    groupId: snapshot.groupId,
  });
  const publicView = Schema.decodeUnknownSync(GroupSnapshot)({
    ...snapshot,
    grantToken: "secret",
    ticket: "secret",
    password: "secret",
  });
  expect(JSON.stringify(publicView)).not.toContain("secret");
});
test("positions preserve fractions and reject nonfinite or negative values and invalid playback invariants", () => {
  const decode = Schema.decodeUnknownSync(PlaybackSeconds);
  expect(decode(1.125)).toBe(1.125);
  for (const value of [-1, NaN, Infinity, -Infinity]) expect(() => decode(value)).toThrow();
  expect(Schema.decodeUnknownSync(IpcPlayerState.fields.positionSeconds)(3.875)).toBe(3.875);
  const snapshot = watchGroupSnapshot();
  if (snapshot.playback.type !== "playback") return;
  const state = snapshot.playback.state;
  for (const invalid of [
    { ...state, mode: "stopped" },
    { ...state, media: null },
    { ...state, anchorPositionMs: 999_999 },
    { ...state, alignmentRevision: 50 },
    { ...state, playbackId: "invalid" },
  ])
    expect(() => Schema.decodeUnknownSync(GroupPlayback)(invalid)).toThrow();
});
test("unknown versions, malformed frame types and empty passwords fail explicitly", () => {
  for (const frame of [
    { protocolVersion: 2, type: "request-snapshot" },
    { protocolVersion: 1, type: "surprise" },
    { protocolVersion: 1, type: "clock-ping", probeId: "not-a-uuid" },
  ])
    expect(() => Schema.decodeUnknownSync(GroupClientFrame)(frame)).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CreateWatchGroup)({
      name: "Friday",
      password: "",
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CreateWatchGroup)({ name: "  ", idempotencyKey: crypto.randomUUID() }),
  ).toThrow();
});
