import type { AppUpdater } from "electron-updater";

type Updater = Pick<
  AppUpdater,
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "allowPrerelease"
  | "allowDowngrade"
  | "disableWebInstaller"
  | "on"
  | "checkForUpdates"
>;

interface WindowsAutoUpdateOptions {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly isPortable: boolean;
  readonly createUpdater: () => Promise<Updater>;
  readonly notifyDownloaded: (version: string) => void;
  readonly scheduleCheck?: (check: () => void) => () => void;
}

const schedulePeriodicCheck = (check: () => void): (() => void) => {
  const timer = setInterval(check, 6 * 60 * 60 * 1_000);
  timer.unref();
  return () => clearInterval(timer);
};

export const startWindowsAutoUpdates = async (
  options: WindowsAutoUpdateOptions,
): Promise<() => void> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isPortable)
    return () => undefined;

  let updater: Updater;
  try {
    updater = await options.createUpdater();
  } catch (cause) {
    console.error("Could not initialize Windows updates", cause);
    return () => undefined;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  // Keep this listener through app quit: installation errors also arrive here.
  updater.on("error", (cause) => console.error("Windows update failed", cause));

  let stopped = false;
  let checking = false;
  let downloaded = false;
  const check = async (): Promise<void> => {
    if (stopped || checking || downloaded) return;
    checking = true;
    try {
      const result = await updater.checkForUpdates();
      if (result?.downloadPromise != null) {
        await result.downloadPromise;
        downloaded = true;
        cancelSchedule();
        if (!stopped) options.notifyDownloaded(result.updateInfo.version);
      }
    } catch (cause) {
      console.error("Could not check or download Windows update", cause);
    } finally {
      checking = false;
    }
  };
  const cancelSchedule = (options.scheduleCheck ?? schedulePeriodicCheck)(() => void check());
  void check();
  return () => {
    stopped = true;
    cancelSchedule();
  };
};
