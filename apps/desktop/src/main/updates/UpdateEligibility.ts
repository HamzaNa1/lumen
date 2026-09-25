import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface UpdateEnvironment {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly version: string;
  readonly executablePath: string;
  readonly resourcesPath: string;
  readonly appImagePath?: string;
  readonly portableExecutablePath?: string;
}

export interface UpdateEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

const writable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true; }
  catch { return false; }
};

export const updateEligibility = (environment: UpdateEnvironment): UpdateEligibility => {
  if (!environment.packaged) return { eligible: false, reason: "Automatic updates are disabled in development builds." };
  if (environment.version.includes("-")) return { eligible: false, reason: "Prerelease clients receive manual updates." };
  if (!existsSync(join(environment.resourcesPath, "app-update.yml"))) {
    return { eligible: false, reason: "This package has no update configuration." };
  }
  if (environment.platform === "win32") {
    if (environment.portableExecutablePath) {
      return { eligible: false, reason: "Automatic updates require the installed Windows version." };
    }
    return writable(dirname(environment.executablePath))
      ? { eligible: true }
      : { eligible: false, reason: "The installation location is not writable." };
  }
  if (environment.platform === "linux") {
    if (!environment.appImagePath) {
      return { eligible: false, reason: "Automatic updates require the AppImage version." };
    }
    const path = resolve(environment.appImagePath);
    return writable(path) && writable(dirname(path))
      ? { eligible: true }
      : { eligible: false, reason: "The AppImage location is not writable." };
  }
  if (environment.platform === "darwin") {
    const bundle = environment.executablePath.match(/^(.*\.app)\/Contents\/MacOS\//u)?.[1];
    if (!bundle || !writable(dirname(bundle))) {
      return { eligible: false, reason: "Install Lumen in a writable application location to receive updates." };
    }
    return { eligible: true };
  }
  return { eligible: false, reason: "Automatic updates are unavailable on this platform." };
};
