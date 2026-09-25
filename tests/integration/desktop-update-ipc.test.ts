import { expect, test } from "bun:test";
import { IpcUpdateState } from "../../packages/contracts/src/ipc";
import { Schema } from "effect";
import { isMainWindowFrame } from "../../apps/desktop/src/main/updates/UpdateIpcPolicy";

test("status is available only to the main window's main frame", () => {
  const frame = {};
  const contents = { mainFrame: frame };
  const window = { webContents: contents };
  expect(isMainWindowFrame(contents, frame, window)).toBe(true);
  expect(isMainWindowFrame(contents, {}, window)).toBe(false);
  expect(isMainWindowFrame({ mainFrame: frame }, frame, window)).toBe(false);
});

test("update state contract rejects invalid progress and phase", () => {
  const valid = {
    revision: 2, currentVersion: "1.0.0", phase: "downloading",
    availableVersion: "1.0.1", progressPercent: 50,
    lastCheckedAtMs: Date.now(), message: null,
  };
  expect(Schema.decodeUnknownSync(IpcUpdateState)(valid).progressPercent).toBe(50);
  expect(() => Schema.decodeUnknownSync(IpcUpdateState)({ ...valid, progressPercent: 101 })).toThrow();
  expect(() => Schema.decodeUnknownSync(IpcUpdateState)({ ...valid, phase: "install-now" })).toThrow();
});
