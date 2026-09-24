import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

interface NativeManifest {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly mpvVersion: string;
  readonly files: Readonly<Record<string, string>>;
}

const manifestName = "mpv-manifest.json";
const platform = process.platform;
const binary = platform === "darwin" ? "libmpv.dylib" : platform === "win32" ? "mpv.exe" : "mpv";
const candidates = [
  join(process.cwd(), "apps", "desktop", "resources", "native", binary),
  join(process.cwd(), "resources", "native", binary),
];
const found = candidates.find(existsSync);
if (found === undefined) {
  throw new Error(`Packaged MPV binary is missing: ${candidates.join(", ")}`);
}
if (platform !== "win32" && platform !== "darwin") accessSync(found, constants.X_OK);

const root = dirname(found);
const manifestPath = join(root, manifestName);
const relativePath = (path: string): string => relative(root, path).split(sep).join("/");
const nativeFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return nativeFiles(path);
    if (!entry.isFile() || entry.name === manifestName) return [];
    return [path];
  });
const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const currentFiles = (): Record<string, string> =>
  Object.fromEntries(
    nativeFiles(root)
      .sort((left, right) => relativePath(left).localeCompare(relativePath(right)))
      .map((path) => [relativePath(path), digest(path)]),
  );

if (process.argv.includes("--write-manifest")) {
  const mpvVersion = process.env.LUMEN_MPV_VERSION;
  if (mpvVersion === undefined || mpvVersion.length === 0) {
    throw new Error("LUMEN_MPV_VERSION is required when creating the native manifest");
  }
  const manifest: NativeManifest = { version: 1, platform, mpvVersion, files: currentFiles() };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(manifestPath);
} else {
  if (!existsSync(manifestPath)) throw new Error(`Native manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NativeManifest;
  if (manifest.version !== 1 || manifest.platform !== platform) {
    throw new Error(`Native manifest does not match ${platform}`);
  }
  const actual = currentFiles();
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("Packaged MPV files do not match the native manifest");
  }
  console.log(`${found} (${manifest.mpvVersion})`);
}
