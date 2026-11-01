import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { verifyMacosLibraries } from "./lib/macos-libraries";
import { nativeFiles } from "./lib/native-files";

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
if (platform === "darwin") {
  verifyMacosLibraries(root);
  const { load } = await import("koffi");
  const library = load(found);
  try {
    const create = library.func("void *mpv_create(void)");
    const setOption = library.func("int mpv_set_option_string(void *, const char *, const char *)");
    const initialize = library.func("int mpv_initialize(void *)");
    const destroy = library.func("void mpv_terminate_destroy(void *)");
    const handle = create();
    if (!handle) throw new Error("Bundled libmpv could not create a player");
    try {
      for (const [name, value] of [
        ["config", "no"],
        ["vo", "null"],
        ["ao", "null"],
      ])
        if (setOption(handle, name, value) < 0)
          throw new Error(`Bundled libmpv rejected smoke-test option ${name}`);
      if (initialize(handle) < 0) throw new Error("Bundled libmpv could not initialize a player");
    } finally {
      destroy(handle);
    }
  } finally {
    library.unload();
  }
}
if (platform === "win32") {
  for (const name of [
    "Lumen Video Helper.exe",
    "libmpv-2.dll",
    "vulkan-1.dll",
    "d3dcompiler_43.dll",
    "d3dcompiler_47.dll",
    "dependencies.json",
    "licenses/mpv-Copyright",
    "licenses/mpv-LICENSE.GPL",
    "licenses/electron-LICENSE",
    "licenses/electron-LICENSES.chromium.html",
  ]) {
    if (!existsSync(join(root, name)))
      throw new Error(`Packaged native dependency is missing: ${name}`);
  }
}
const manifestPath = join(root, manifestName);
const relativePath = (path: string): string => relative(root, path).split(sep).join("/");
const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const currentFiles = (): Record<string, string> =>
  Object.fromEntries(
    [...nativeFiles(root)]
      .filter((path) => basename(path) !== manifestName)
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
