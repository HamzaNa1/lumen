import { autoUpdater as nativeMacUpdater } from "electron";
import electronUpdater from "electron-updater";
import type { EventEmitter } from "node:events";
import { waitForMacStaging } from "./MacStaging";
import type { UpdateAdapter } from "./UpdateService";

const { autoUpdater } = electronUpdater;

export class ElectronUpdateAdapter implements UpdateAdapter {
  private readonly progressListeners = new Set<(percent: number) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();

  constructor() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
    // The updater's default logger can include release URLs. Keep diagnostics in UpdateService.
    autoUpdater.logger = null;
    // Keep this error listener attached through the final app quit, even after service disposal.
    autoUpdater.on("error", (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
    autoUpdater.on("download-progress", (progress) => {
      for (const listener of this.progressListeners) listener(progress.percent);
    });
  }

  async check(): ReturnType<UpdateAdapter["check"]> {
    const staging = process.platform === "darwin"
      ? waitForMacStaging(nativeMacUpdater as unknown as EventEmitter)
      : null;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result === null || result === undefined) { staging?.dispose(); return null; }
      if (result.downloadPromise == null) {
        staging?.dispose();
        return { version: result.updateInfo.version };
      }
      const download = result.downloadPromise;
      return {
        version: result.updateInfo.version,
        downloadPromise: (async () => {
          try {
            await download;
            await staging?.promise;
          } finally { staging?.dispose(); }
        })(),
      };
    } catch (error) {
      staging?.dispose();
      throw error;
    }
  }

  onProgress(listener: (percent: number) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
}
