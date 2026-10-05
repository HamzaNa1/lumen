/** The part of electron-updater's `autoUpdater` this app drives. */
export interface UpdateSource {
  allowPrerelease: boolean;
  on(event: "update-downloaded", listener: (info: { readonly version: string }) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface UpdateHost {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** Set by the portable Windows build, which runs from wherever its single file was put. */
  readonly portableExecutable: string | undefined;
}

/**
 * Only the installed Windows build updates itself. macOS refuses updates to an unsigned app, and
 * the portable build has no installation for the installer to replace.
 */
export const supportsAutoUpdates = (host: UpdateHost): boolean =>
  host.platform === "win32" && host.isPackaged && host.portableExecutable === undefined;

const checkIntervalMs = 4 * 60 * 60 * 1_000;

/**
 * Downloads new releases in the background and reports when one is ready. A ready update is
 * installed when the app next quits, or straight away when the viewer asks for it.
 */
export class AppUpdates {
  private source: UpdateSource | null = null;
  private readyVersion: string | null = null;

  constructor(private readonly onReady: (version: string) => void) {}

  /** The version waiting to be installed, if one has been downloaded. */
  get ready(): string | null {
    return this.readyVersion;
  }

  /** Checks now and every few hours after, since the app can stay open for days. */
  start(source: UpdateSource): () => void {
    this.source = source;
    // A prerelease build would otherwise follow the newest tag in the repository, which can be a
    // server release. Everyone follows GitHub's Latest release, which is always a stable desktop one.
    source.allowPrerelease = false;
    source.on("update-downloaded", ({ version }) => {
      this.readyVersion = version;
      this.onReady(version);
    });
    const check = (): void => {
      // Being offline or between releases is routine; the next check tries again.
      void source.checkForUpdates().catch((cause: unknown) => {
        console.error("Failed to check for updates", cause);
      });
    };
    check();
    const timer = setInterval(check, checkIntervalMs);
    return () => clearInterval(timer);
  }

  /** Quits, installs the downloaded update without prompts and reopens the app. */
  install(): void {
    if (this.source === null || this.readyVersion === null) throw new Error("No update is ready");
    this.source.quitAndInstall(true, true);
  }
}
