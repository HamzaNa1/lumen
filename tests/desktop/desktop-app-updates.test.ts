import { expect, jest, test } from "bun:test";
import {
  AppUpdates,
  supportsAutoUpdates,
  type UpdateSource,
} from "../../apps/desktop/src/main/updates/AppUpdates";

const fakeSource = (check: UpdateSource["checkForUpdates"] = async () => null) => {
  let downloaded: ((info: { readonly version: string }) => void) | undefined;
  const calls = { checks: 0, installs: [] as Array<[boolean, boolean]> };
  const source: UpdateSource = {
    allowPrerelease: true,
    on: (_event, listener) => {
      downloaded = listener;
    },
    checkForUpdates: () => {
      calls.checks += 1;
      return check();
    },
    quitAndInstall: (isSilent, isForceRunAfter) => {
      calls.installs.push([isSilent, isForceRunAfter]);
    },
  };
  return { source, calls, download: (version: string) => downloaded?.({ version }) };
};

test("only the installed Windows build updates itself", () => {
  const installed = { platform: "win32", isPackaged: true, portableExecutable: undefined } as const;
  expect(supportsAutoUpdates(installed)).toBe(true);
  expect(supportsAutoUpdates({ ...installed, platform: "darwin" })).toBe(false);
  expect(supportsAutoUpdates({ ...installed, platform: "linux" })).toBe(false);
  expect(supportsAutoUpdates({ ...installed, isPackaged: false })).toBe(false);
  expect(supportsAutoUpdates({ ...installed, portableExecutable: "C:\\Lumen.exe" })).toBe(false);
});

test("a downloaded update is reported and installed on request", () => {
  const ready: string[] = [];
  const updates = new AppUpdates((version) => ready.push(version));
  const { source, calls, download } = fakeSource();
  expect(() => updates.install()).toThrow("No update is ready");
  const stop = updates.start(source);
  try {
    expect(source.allowPrerelease).toBe(false);
    expect(calls.checks).toBe(1);
    expect(updates.ready).toBeNull();
    expect(() => updates.install()).toThrow("No update is ready");

    download("0.0.13");
    expect(ready).toEqual(["0.0.13"]);
    expect(updates.ready).toBe("0.0.13");
    updates.install();
    expect(calls.installs).toEqual([[true, true]]);
  } finally {
    stop();
  }
});

test("a failed download is handled like a failed check", async () => {
  const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown): void => {
    unhandled.push(cause);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const failure = new Error("connection lost");
    const { source } = fakeSource(async () => ({ downloadPromise: Promise.reject(failure) }));
    new AppUpdates(() => undefined).start(source)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalledWith("Failed to update", failure);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    errors.mockRestore();
  }
});

test("update checks repeat and survive failures", async () => {
  jest.useFakeTimers();
  const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { source, calls } = fakeSource(async () => {
      throw new Error("offline");
    });
    const stop = new AppUpdates(() => undefined).start(source);
    await Promise.resolve();
    jest.advanceTimersByTime(4 * 60 * 60 * 1_000);
    expect(calls.checks).toBe(2);
    stop();
    jest.advanceTimersByTime(4 * 60 * 60 * 1_000);
    expect(calls.checks).toBe(2);
    await Promise.resolve();
    expect(errors).toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    jest.useRealTimers();
  }
});
