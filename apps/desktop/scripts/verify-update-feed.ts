import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Installed apps trust `latest.yml` to name the next installer. A feed that names a file the
// release does not carry, or carries a different digest, would break updating for everyone.
const releaseDirectory = join(import.meta.dirname, "..", "release");
const manifest: { readonly version: string } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
);
const feedPath = join(releaseDirectory, "latest.yml");
if (!existsSync(feedPath)) throw new Error(`Update feed is missing: ${feedPath}`);
const feed = Bun.YAML.parse(readFileSync(feedPath, "utf8")) as {
  readonly version?: unknown;
  readonly path?: unknown;
  readonly sha512?: unknown;
};

if (feed.version !== manifest.version) {
  throw new Error(`Update feed is for ${String(feed.version)}, not ${manifest.version}`);
}
const installer = feed.path;
// GitHub renames uploaded assets that contain spaces, so the app would ask for a missing file.
if (typeof installer !== "string" || !/^[\w.-]+\.exe$/u.test(installer)) {
  throw new Error(`Update feed names an unusable installer: ${String(installer)}`);
}
for (const file of [installer, `${installer}.blockmap`]) {
  if (!existsSync(join(releaseDirectory, file))) {
    throw new Error(`Update feed needs ${file}, which was not packaged`);
  }
}
const digest = createHash("sha512")
  .update(readFileSync(join(releaseDirectory, installer)))
  .digest("base64");
if (digest !== feed.sha512) throw new Error(`Update feed digest does not match ${installer}`);
console.log(`${feedPath} -> ${installer}`);
