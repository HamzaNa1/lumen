import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { startWindowsAutoUpdates } from "../../apps/desktop/src/main/WindowsAutoUpdates";

type Options = Parameters<typeof startWindowsAutoUpdates>[0];
type Updater = Awaited<ReturnType<Options["createUpdater"]>>;
type CheckResult = Awaited<ReturnType<Updater["checkForUpdates"]>>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((answer, fail) => {
    resolve = answer;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const updateResult = (downloadPromise: Promise<string[]> | null): CheckResult => {
  const updateInfo = { version: "0.0.12", releaseDate: "2026-10-05", files: [] };
  return { isUpdateAvailable: downloadPromise !== null, updateInfo, versionInfo: updateInfo, downloadPromise };
};

const fixture = () => {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    checkForUpdates: mock<Updater["checkForUpdates"]>(async () => null),
  });
  let tick: () => void = () => undefined;
  const cancelSchedule = mock(() => undefined);
  const options: Options = {
    platform: "win32",
    isPackaged: true,
    isPortable: false,
    createUpdater: mock(async () => updater),
    notifyDownloaded: mock(() => undefined),
    scheduleCheck: mock((check) => {
      tick = check;
      return cancelSchedule;
    }),
  };
  return { updater, options, tick: () => tick(), cancelSchedule };
};

// Complete the check and download continuations without advancing a real timer.
const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

describe("Windows auto updates", () => {
  test.each([
    { platform: "darwin" as const },
    { platform: "linux" as const },
    { isPackaged: false },
    { isPortable: true },
  ])("does not load the updater for unsupported installations (%j)", async (environment) => {
    const { options } = fixture();
    const stop = await startWindowsAutoUpdates({ ...options, ...environment });
    stop();
    expect(options.createUpdater).not.toHaveBeenCalled();
    expect(options.scheduleCheck).not.toHaveBeenCalled();
  });

  test("checks at startup and periodically, accepts only stable upgrades, and installs on exit", async () => {
    const { updater, options, tick } = fixture();
    updater.checkForUpdates.mockResolvedValue(updateResult(null));
    const stop = await startWindowsAutoUpdates(options);
    await flush();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    tick();
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(options.notifyDownloaded).not.toHaveBeenCalled();
    stop();
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  test("does not overlap checks or downloads and notifies once only after download completes", async () => {
    const { updater, options, tick, cancelSchedule } = fixture();
    const check = deferred<CheckResult>();
    const download = deferred<string[]>();
    updater.checkForUpdates.mockReturnValue(check.promise);
    const stop = await startWindowsAutoUpdates(options);
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    check.resolve(updateResult(download.promise));
    await flush();
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(options.notifyDownloaded).not.toHaveBeenCalled();
    download.resolve(["Lumen-Setup-0.0.12-x64.exe"]);
    await flush();
    expect(options.notifyDownloaded).toHaveBeenCalledWith("0.0.12");
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(options.notifyDownloaded).toHaveBeenCalledTimes(1);
    stop();
  });

  test.each(["check", "download"])("recovers from a failed %s on the next scheduled check", async (stage) => {
    const { updater, options, tick } = fixture();
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("Offline");
    if (stage === "check") updater.checkForUpdates.mockRejectedValueOnce(failure);
    else updater.checkForUpdates.mockImplementationOnce(async () => updateResult(Promise.reject(failure)));
    let stop: () => void = () => undefined;
    try {
      stop = await startWindowsAutoUpdates(options);
      await flush();
      expect(options.notifyDownloaded).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalled();
      updater.checkForUpdates.mockResolvedValue(updateResult(Promise.resolve(["installer.exe"])));
      tick();
      await flush();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(options.notifyDownloaded).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      errorLog.mockRestore();
    }
  });

  test("shutdown suppresses late notifications but retains the installer error handler", async () => {
    const { updater, options, tick, cancelSchedule } = fixture();
    const download = deferred<string[]>();
    updater.checkForUpdates.mockResolvedValue(updateResult(download.promise));
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const stop = await startWindowsAutoUpdates(options);
      stop();
      expect(cancelSchedule).toHaveBeenCalled();
      download.resolve(["installer.exe"]);
      await flush();
      tick();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(options.notifyDownloaded).not.toHaveBeenCalled();
      const failure = new Error("Installation failed");
      updater.emit("error", failure);
      expect(errorLog).toHaveBeenCalledWith("Windows update failed", failure);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("an updater initialization error does not break app startup", async () => {
    const { options } = fixture();
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const stop = await startWindowsAutoUpdates({
        ...options,
        createUpdater: async () => { throw new Error("Missing updater"); },
      });
      stop();
      expect(options.scheduleCheck).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
