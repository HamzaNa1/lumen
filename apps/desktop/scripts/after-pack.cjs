const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");

const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? files(path) : entry.isFile() && entry.name !== "mpv-manifest.json" ? [path] : [];
});

exports.default = async (context) => {
  const mac = context.electronPlatformName === "darwin";
  const native = mac
    ? join(context.appOutDir, "Lumen.app", "Contents", "Resources", "resources", "native")
    : join(context.appOutDir, "resources", "native");
  const manifestPath = join(native, "mpv-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const paths = files(native).sort();
  if (mac) {
    const identity = process.env.LUMEN_MAC_SIGN_IDENTITY;
    if (!identity) throw new Error("LUMEN_MAC_SIGN_IDENTITY is required to sign nested MPV libraries");
    for (const path of paths) {
      if (path.endsWith(".dylib") || path.endsWith(".so")) {
        execFileSync("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", path], { stdio: "inherit" });
      }
    }
  }
  manifest.files = Object.fromEntries(paths.map((path) => [
    relative(native, path).replaceAll("\\", "/"),
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
