import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import YAML from "yaml";

interface Asset { readonly name: string; readonly path: string; readonly size: number }
interface FeedFile { readonly url: string; readonly sha512: string; readonly size: number }
interface Feed { readonly version: string; readonly files: FeedFile[] }

const fail = (message: string): never => { throw new Error(message); };
const root = process.argv[2];
const version = process.argv[process.argv.indexOf("--version") + 1];
const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex < 0 ? null : process.argv[releaseIndex + 1];
if (!root || !version || version.startsWith("--")) fail("Usage: verify-update-artifacts.ts <directory> --version <version> [--release <tag>]");

const channel = version.includes("-") ? version.split("-")[1]?.split(".")[0] : "latest";
if (!channel || !["latest", "alpha", "beta", "rc"].includes(channel)) fail(`Unsupported release channel: ${channel}`);

const listFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
});
const isAssetName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:AppImage|deb|dmg|zip|exe|blockmap|yml)$/u.test(name);

const files = listFiles(root).filter((path) => basename(path) !== "files.txt");
const assets = new Map<string, Asset>();
for (const path of files) {
  const name = basename(path);
  if (!isAssetName(name)) fail(`Unexpected release file: ${relative(root, path)}`);
  if (assets.has(name)) fail(`Duplicate release basename: ${name}`);
  assets.set(name, { name, path, size: statSync(path).size });
}
const all = [...assets.values()];
const count = (predicate: (name: string) => boolean): number => all.filter((asset) => predicate(asset.name)).length;
for (const [kind, predicate, expected] of [
  ["AppImage", (name: string) => name.endsWith(".AppImage"), 1],
  ["DEB", (name: string) => name.endsWith(".deb"), 1],
  ["DMG", (name: string) => name.endsWith(".dmg"), 1],
  ["ZIP", (name: string) => name.endsWith(".zip"), 1],
  ["Windows installers", (name: string) => name.endsWith(".exe"), 2],
] as const) {
  if (count(predicate) !== expected) fail(`Expected ${expected} ${kind} artifact(s), found ${count(predicate)}`);
}
if (count((name) => /^Lumen-Setup-.*\.exe$/u.test(name)) !== 1 ||
    count((name) => /^Lumen-Portable-.*\.exe$/u.test(name)) !== 1) {
  fail("Windows Setup and Portable artifacts must be distinct");
}
for (const asset of all) {
  if (!asset.name.endsWith(".yml") && !asset.name.endsWith(".blockmap") && !asset.name.includes(version)) {
    fail(`Artifact version does not match: ${asset.name}`);
  }
}

const expectedFeeds = [`${channel}.yml`, `${channel}-mac.yml`, `${channel}-linux.yml`];
for (const name of expectedFeeds) if (!assets.has(name)) fail(`Missing update feed: ${name}`);
const feedNames = all.filter((asset) => asset.name.endsWith(".yml")).map((asset) => asset.name);
if (feedNames.length !== expectedFeeds.length || feedNames.some((name) => !expectedFeeds.includes(name))) {
  fail(`Unexpected update channel metadata: ${feedNames.join(", ")}`);
}

const digest = async (path: string, algorithm: "sha512" | "sha256"): Promise<string> => {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm === "sha512" ? "base64" : "hex");
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parseFeed = (name: string): Feed => {
  const asset = assets.get(name);
  if (!asset) fail(`Missing update feed: ${name}`);
  const raw = YAML.parse(readFileSync(asset.path, "utf8")) as unknown;
  if (!isObject(raw) || raw.version !== version || !Array.isArray(raw.files) || raw.files.length === 0) {
    fail(`Invalid version or files in ${name}`);
  }
  const feedFiles: FeedFile[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.files) {
    if (!isObject(candidate) || typeof candidate.url !== "string" ||
        typeof candidate.sha512 !== "string" || typeof candidate.size !== "number" ||
        !Number.isSafeInteger(candidate.size) || candidate.size < 1) fail(`Invalid file entry in ${name}`);
    if (!isAssetName(candidate.url) || candidate.url.includes("..")) fail(`Unsafe payload reference in ${name}: ${candidate.url}`);
    if (seen.has(candidate.url)) fail(`Duplicate payload reference in ${name}: ${candidate.url}`);
    seen.add(candidate.url);
    feedFiles.push(candidate as unknown as FeedFile);
  }
  if (raw.path !== undefined || raw.sha512 !== undefined) {
    const primary = feedFiles.find((file) => file.url === raw.path);
    if (!primary || primary.sha512 !== raw.sha512) fail(`Legacy primary payload disagrees with files in ${name}`);
  }
  return { version, files: feedFiles };
};
const feeds = new Map(expectedFeeds.map((name) => [name, parseFeed(name)]));
const expectedType = (name: string, payload: string): boolean =>
  name.endsWith("-mac.yml") ? payload.endsWith(".zip") || payload.endsWith(".dmg") :
  name.endsWith("-linux.yml") ? payload.endsWith(".AppImage") || payload.endsWith(".deb") :
  /^Lumen-Setup-.*\.exe$/u.test(payload);

for (const [name, feed] of feeds) {
  for (const file of feed.files) {
    if (!expectedType(name, file.url)) fail(`Wrong platform payload ${file.url} in ${name}`);
    const asset = assets.get(file.url);
    if (!asset) fail(`Missing referenced payload ${file.url} in ${name}`);
    if (asset.size !== file.size || await digest(asset.path, "sha512") !== file.sha512) {
      fail(`Size or SHA-512 mismatch: ${file.url}`);
    }
  }
}
const hasPayload = (feedName: string, suffix: string): boolean =>
  feeds.get(feedName)?.files.some((file) => file.url.endsWith(suffix)) ?? false;
if (!hasPayload(`${channel}.yml`, ".exe") ||
    !hasPayload(`${channel}-mac.yml`, ".zip") ||
    !hasPayload(`${channel}-linux.yml`, ".AppImage")) {
  fail("Update feeds must select NSIS, macOS ZIP, and Linux AppImage payloads");
}
if (!feeds.get(`${channel}.yml`)?.files.some((file) => /^Lumen-Setup-.*-x64\.exe$/u.test(file.url)) ||
    !feeds.get(`${channel}-mac.yml`)?.files.some((file) => /arm64.*\.zip$/u.test(file.url))) {
  fail("Update feeds must select the packaged Windows x64 and macOS ARM64 payloads");
}
if (!version.includes("-") && [...feeds.values()].some((feed) => feed.version.includes("-"))) {
  fail("Stable feed advertises a prerelease");
}
for (const asset of all.filter((item) => item.name.endsWith(".blockmap"))) {
  if (!assets.has(asset.name.slice(0, -".blockmap".length))) fail(`Orphan blockmap: ${asset.name}`);
}
const setup = all.find((asset) => /^Lumen-Setup-.*\.exe$/u.test(asset.name));
if (!setup) fail("NSIS setup artifact is missing");
if (!assets.has(`${setup.name}.blockmap`)) fail(`Missing NSIS blockmap: ${setup.name}.blockmap`);
const macZip = all.find((asset) => asset.name.endsWith(".zip"));
if (!macZip || !assets.has(`${macZip.name}.blockmap`)) fail("Missing macOS ZIP blockmap");

if (release !== null) {
  const repository = process.env.GH_REPO;
  if (!repository || !/^[-\w]+\/[-\w]+$/u.test(repository)) fail("GH_REPO is required for remote validation");
  const result = Bun.spawnSync(["gh", "api", `repos/${repository}/releases/tags/${release}`], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`Could not inspect draft release ${release}`);
  const remote = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    draft: boolean; target_commitish: string;
    assets: { name: string; size: number; digest?: string }[];
  };
  if (!remote.draft || remote.target_commitish !== process.env.GITHUB_SHA) fail("Release is published or points at a different commit");
  if (remote.assets.length !== all.length) fail("Remote asset count differs from validated inventory");
  for (const asset of all) {
    const uploaded = remote.assets.find((item) => item.name === asset.name);
    if (!uploaded || uploaded.size !== asset.size) fail(`Remote asset missing or changed: ${asset.name}`);
    if (uploaded.digest && uploaded.digest !== `sha256:${await digest(asset.path, "sha256")}`) {
      fail(`Remote SHA-256 mismatch: ${asset.name}`);
    }
  }
}

mkdirSync(root, { recursive: true });
writeFileSync(join(root, "files.txt"), all.sort((a, b) => a.name.localeCompare(b.name)).map((asset) => `${asset.path}\n`).join(""));
console.log(`Verified ${all.length} release assets for ${version}${release ? ` on ${release}` : ""}`);
