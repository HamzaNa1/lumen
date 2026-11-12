import type { AppUpdate, AppUpdateStatus } from "@lumen/contracts";
import { Schema } from "effect";
import { JsonFileStore } from "../storage/JsonFileStore";

/** The part of electron-updater's `autoUpdater` this app drives. */
export interface UpdateSource {
  allowPrerelease: boolean;
  autoDownload: boolean;
  on(
    event: "download-progress",
    listener: (progress: { readonly percent: number }) => void,
  ): unknown;
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable: boolean;
    readonly updateInfo: { readonly version: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

/** Where an installation that cannot update itself learns of new releases and gets them. */
export interface ReleasePage {
  /** The version of the latest stable release. */
  readonly latest: () => Promise<string>;
  readonly open: () => Promise<void>;
}

export type UpdateChannel =
  | { readonly kind: "installer"; readonly source: UpdateSource }
  | { readonly kind: "page"; readonly page: ReleasePage };

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

/**
 * Reads GitHub's Latest release, which is always a stable desktop one. Asked for JSON, GitHub
 * answers `/releases/latest` with the release's tag, such as `v0.0.38+desktop`.
 */
export const githubReleasePage = (
  releasesUrl: string,
  openExternal: (url: string) => Promise<void>,
): ReleasePage => ({
  latest: async () => {
    const response = await fetch(`${releasesUrl}/latest`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Release lookup failed with HTTP ${response.status}`);
    const { tag_name } = Schema.decodeUnknownSync(Schema.Struct({ tag_name: Schema.String }))(
      await response.json(),
    );
    return tag_name.replace(/^v/u, "").replace(/\+.*$/u, "");
  },
  open: () => openExternal(`${releasesUrl}/latest`),
});

const parseVersion = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[^+]+)?/u.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
};

/** Whether a release is newer than the running one. A prerelease is older than its release. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const next = parseVersion(candidate);
  const running = parseVersion(current);
  if (next === null || running === null) return false;
  for (const [index, part] of next.core.entries()) {
    const other = running.core[index] ?? 0;
    if (part !== other) return part > other;
  }
  return running.prerelease && !next.prerelease;
};

const UpdateSettings = Schema.Struct({
  automatic: Schema.Boolean,
  /** A version downloaded but not installed yet, which the next launch installs. */
  downloaded: Schema.NullOr(Schema.String),
});
type UpdateSettings = Schema.Schema.Type<typeof UpdateSettings>;

export const openUpdateSettings = (path: string): Promise<JsonFileStore<UpdateSettings>> =>
  JsonFileStore.open({
    path,
    schema: UpdateSettings,
    defaults: () => ({ automatic: true, downloaded: null }),
    name: "update settings",
  });

const checkIntervalMs = 30 * 60 * 1_000;

/**
 * Finds new releases and takes the viewer through getting one. An installation that updates
 * itself downloads it, in the background unless the viewer turned that off, and installs it when
 * asked, when the app quits, or when it next starts. Any other installation points the viewer to
 * the release page.
 */
export class AppUpdates {
  private update: AppUpdate | null = null;
  private downloading: Promise<void> | null = null;

  constructor(
    private readonly options: {
      readonly channel: UpdateChannel | null;
      readonly currentVersion: string;
      readonly settings: JsonFileStore<UpdateSettings>;
      readonly onChange: (status: AppUpdateStatus) => void;
      readonly intervalMs?: number;
    },
  ) {}

  get status(): AppUpdateStatus {
    return {
      automatic:
        this.options.channel?.kind === "installer" ? this.options.settings.current.automatic : null,
      update: this.update,
    };
  }

  /** Checks now and every half hour after, so a release published mid-session still shows up. */
  start(): () => void {
    const { channel, settings, currentVersion } = this.options;
    if (channel === null) return () => undefined;
    const { downloaded } = settings.current;
    if (downloaded !== null && !isNewerVersion(downloaded, currentVersion))
      settings.set({ ...settings.current, downloaded: null });
    let pending =
      downloaded !== null && isNewerVersion(downloaded, currentVersion) ? downloaded : null;
    if (channel.kind === "installer") {
      // A prerelease build would otherwise follow the newest tag in the repository, which can be a
      // server release. Everyone follows GitHub's Latest release, which is always a stable desktop one.
      channel.source.allowPrerelease = false;
      channel.source.autoDownload = false;
      channel.source.on("download-progress", ({ percent }) => {
        if (this.update?.phase === "downloading")
          this.publish({ ...this.update, progress: Math.min(Math.max(percent / 100, 0), 1) });
      });
    }
    const check = (): void => {
      // Only the first check installs what an earlier launch downloaded; a later one would quit
      // the app in the middle of whatever the viewer is doing.
      const installing = pending;
      pending = null;
      // Being offline or losing the connection mid-download is routine; the next check tries again.
      void this.check(channel, installing).catch((cause: unknown) => {
        console.error("Failed to update", cause);
      });
    };
    check();
    const timer = setInterval(check, this.options.intervalMs ?? checkIntervalMs);
    return () => clearInterval(timer);
  }

  /** Starts downloading the update, or opens its release page where the app cannot install it. */
  async download(): Promise<void> {
    const { channel } = this.options;
    if (channel === null || this.update === null) throw new Error("No update is available");
    if (channel.kind === "page") return channel.page.open();
    await this.downloadFrom(channel.source);
  }

  /** Quits, installs the downloaded update without prompts and reopens the app. */
  install(): void {
    const { channel } = this.options;
    if (channel?.kind !== "installer" || this.update?.phase !== "ready")
      throw new Error("No update is ready");
    channel.source.quitAndInstall(true, true);
  }

  setAutomatic(automatic: boolean): AppUpdateStatus {
    const { channel, settings } = this.options;
    if (channel?.kind !== "installer") throw new Error("This installation cannot update itself");
    settings.set({ ...settings.current, automatic });
    this.publish(this.update);
    if (automatic && this.update?.phase === "available")
      void this.downloadFrom(channel.source).catch((cause: unknown) => {
        console.error("Failed to update", cause);
      });
    return this.status;
  }

  private async check(channel: UpdateChannel, installing: string | null): Promise<void> {
    if (channel.kind === "page") {
      const version = await channel.page.latest();
      if (isNewerVersion(version, this.options.currentVersion) && this.update?.version !== version)
        this.publish({ version, phase: "available", progress: 0 });
      return;
    }
    const result = await channel.source.checkForUpdates();
    if (result?.isUpdateAvailable !== true) return;
    const { version } = result.updateInfo;
    if (this.update?.version !== version)
      this.publish({ version, phase: "available", progress: 0 });
    if (!this.options.settings.current.automatic && version !== installing) return;
    await this.downloadFrom(channel.source);
    if (version !== installing || this.update?.phase !== "ready") return;
    // One attempt per download: an installer that fails must not close the app on every launch.
    this.options.settings.set({ ...this.options.settings.current, downloaded: null });
    await this.options.settings.saved();
    channel.source.quitAndInstall(true, true);
  }

  private downloadFrom(source: UpdateSource): Promise<void> {
    const update = this.update;
    if (update === null || update.phase === "ready") return Promise.resolve();
    this.downloading ??= (async () => {
      this.publish({ ...update, phase: "downloading", progress: 0 });
      try {
        await source.downloadUpdate();
        this.publish({ ...update, phase: "ready", progress: 1 });
        const { settings } = this.options;
        settings.set({ ...settings.current, downloaded: update.version });
      } catch (cause) {
        this.publish({ ...update, phase: "available", progress: 0 });
        throw cause;
      } finally {
        this.downloading = null;
      }
    })();
    return this.downloading;
  }

  private publish(update: AppUpdate | null): void {
    this.update = update;
    this.options.onChange(this.status);
  }
}
